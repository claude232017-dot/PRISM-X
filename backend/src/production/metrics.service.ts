import { Injectable } from '@nestjs/common';

/**
 * The metrics registry.
 *
 * Deliberately implemented here rather than pulled in. The exposition format is
 * a few lines, the aggregation is arithmetic, and what a metrics client buys —
 * a process collector, a pushgateway, an exemplar API — is not what this
 * system needs from Phase 8. What it does need is for the numbers the readiness
 * review reads, the alert engine evaluates and the dashboard renders to be
 * *the same numbers*, which is easier to guarantee when there is one registry
 * that all three read.
 *
 * Three instrument kinds:
 *
 *  - **Counter** — monotonic. Requests, errors, tokens, jobs.
 *  - **Gauge** — a value that goes both ways. Queue depth, memory, instances.
 *  - **Histogram** — a distribution. Latency, mostly.
 *
 * Histograms keep a bounded reservoir of raw observations rather than only
 * bucket counts, because the readiness review asks for a p95 and a p95
 * reconstructed from coarse buckets is a p95-shaped number rather than a p95.
 * The reservoir is capped, so memory is bounded regardless of traffic; past the
 * cap it keeps the most recent observations, which is the right bias for a
 * question always asked about now.
 */

export type MetricKind = 'counter' | 'gauge' | 'histogram';

interface Series {
  kind: MetricKind;
  help: string;
  /** Label set → value, keyed by a canonical serialisation of the labels. */
  values: Map<string, { labels: Record<string, string>; value: number }>;
  /** Raw observations, histograms only. */
  samples: Map<string, number[]>;
}

const RESERVOIR = 1_000;

@Injectable()
export class MetricsService {
  private readonly series = new Map<string, Series>();
  private readonly startedAt = Date.now();

  private ensure(name: string, kind: MetricKind, help: string): Series {
    const existing = this.series.get(name);
    if (existing) return existing;
    const created: Series = { kind, help, values: new Map(), samples: new Map() };
    this.series.set(name, created);
    return created;
  }

  /** Canonical, sorted, so the same labels always produce the same key. */
  private static key(labels: Record<string, string>): string {
    const entries = Object.entries(labels)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`).join(',');
  }

  increment(name: string, labels: Record<string, string> = {}, by = 1, help = ''): void {
    const series = this.ensure(name, 'counter', help);
    const key = MetricsService.key(labels);
    const current = series.values.get(key);
    series.values.set(key, { labels, value: (current?.value ?? 0) + by });
  }

  set(name: string, value: number, labels: Record<string, string> = {}, help = ''): void {
    const series = this.ensure(name, 'gauge', help);
    series.values.set(MetricsService.key(labels), { labels, value });
  }

  observe(name: string, value: number, labels: Record<string, string> = {}, help = ''): void {
    const series = this.ensure(name, 'histogram', help);
    const key = MetricsService.key(labels);

    const current = series.values.get(key);
    series.values.set(key, { labels, value: (current?.value ?? 0) + 1 });

    const samples = series.samples.get(key) ?? [];
    samples.push(value);
    // Bounded: drop the oldest, keep the newest. A p95 is a question about now.
    if (samples.length > RESERVOIR) samples.splice(0, samples.length - RESERVOIR);
    series.samples.set(key, samples);
  }

  /** Times a function and records the outcome, whichever way it goes. */
  async time<T>(
    name: string,
    labels: Record<string, string>,
    work: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const result = await work();
      this.observe(name, Date.now() - started, { ...labels, outcome: 'ok' });
      return result;
    } catch (error) {
      this.observe(name, Date.now() - started, { ...labels, outcome: 'error' });
      throw error;
    }
  }

  // ------------------------------------------------------------- reading

  value(name: string, labels: Record<string, string> = {}): number | null {
    return this.series.get(name)?.values.get(MetricsService.key(labels))?.value ?? null;
  }

  /** Sum across every label set — what an alert on a whole metric wants. */
  total(name: string): number {
    const series = this.series.get(name);
    if (!series) return 0;
    let total = 0;
    for (const entry of series.values.values()) total += entry.value;
    return total;
  }

  /**
   * Nearest-rank percentile over the reservoir. Returns null rather than 0 when
   * there is nothing to measure — a system with no traffic has no p95, and
   * reporting zero would look like excellent performance.
   */
  percentile(name: string, quantile: number, labels?: Record<string, string>): number | null {
    const series = this.series.get(name);
    if (!series) return null;

    const pool: number[] = [];
    if (labels) {
      pool.push(...(series.samples.get(MetricsService.key(labels)) ?? []));
    } else {
      for (const samples of series.samples.values()) pool.push(...samples);
    }
    if (!pool.length) return null;

    const sorted = [...pool].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
    return sorted[Math.max(0, rank)];
  }

  sampleCount(name: string): number {
    const series = this.series.get(name);
    if (!series) return 0;
    let count = 0;
    for (const samples of series.samples.values()) count += samples.length;
    return count;
  }

  mean(name: string): number | null {
    const series = this.series.get(name);
    if (!series) return null;
    let sum = 0;
    let count = 0;
    for (const samples of series.samples.values()) {
      for (const sample of samples) {
        sum += sample;
        count += 1;
      }
    }
    return count ? sum / count : null;
  }

  names(): string[] {
    return [...this.series.keys()].sort();
  }

  /** Structured snapshot, for the dashboard and the readiness review. */
  snapshot(): Record<string, unknown> {
    const metrics: Record<string, unknown> = {};
    for (const [name, series] of this.series) {
      const entries = [...series.values.values()].map((entry) => ({
        labels: entry.labels,
        value: entry.value,
      }));
      metrics[name] = {
        kind: series.kind,
        help: series.help,
        series: entries,
        ...(series.kind === 'histogram'
          ? {
              count: this.sampleCount(name),
              mean: this.mean(name),
              p50: this.percentile(name, 0.5),
              p95: this.percentile(name, 0.95),
              p99: this.percentile(name, 0.99),
            }
          : { total: this.total(name) }),
      };
    }
    return { uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000), metrics };
  }

  /**
   * Prometheus text exposition.
   *
   * Histograms are emitted as `_count`, `_sum` and quantile-labelled gauges
   * rather than as native buckets. That is a deliberate simplification: without
   * a bucket configuration per metric, native histograms would need boundaries
   * chosen up front for latencies nobody has measured yet, and the quantiles
   * computed here are exact over the reservoir rather than interpolated.
   */
  prometheus(): string {
    const lines: string[] = [];

    for (const [name, series] of this.series) {
      const safe = name.replace(/[^a-zA-Z0-9_]/g, '_');
      if (series.help) lines.push(`# HELP ${safe} ${series.help}`);
      lines.push(`# TYPE ${safe} ${series.kind === 'histogram' ? 'summary' : series.kind}`);

      for (const [key, entry] of series.values) {
        const labels = key ? `{${key}}` : '';
        if (series.kind === 'histogram') {
          const samples = series.samples.get(key) ?? [];
          const sum = samples.reduce((acc, s) => acc + s, 0);
          lines.push(`${safe}_count${labels} ${entry.value}`);
          lines.push(`${safe}_sum${labels} ${sum}`);
          for (const quantile of [0.5, 0.95, 0.99]) {
            const value = this.percentile(name, quantile, entry.labels);
            if (value !== null) {
              const inner = key ? `${key},quantile="${quantile}"` : `quantile="${quantile}"`;
              lines.push(`${safe}{${inner}} ${value}`);
            }
          }
        } else {
          lines.push(`${safe}${labels} ${entry.value}`);
        }
      }
    }

    return `${lines.join('\n')}\n`;
  }

  /** Test and rotation support. Never called on a serving path. */
  reset(): void {
    this.series.clear();
  }
}

/** Metric names used across the platform, so a typo is a compile error. */
export const Metric = {
  HttpRequests: 'prismx_http_requests_total',
  HttpErrors: 'prismx_http_errors_total',
  HttpDuration: 'prismx_http_request_duration_ms',
  MissionsStarted: 'prismx_missions_started_total',
  MissionsCompleted: 'prismx_missions_completed_total',
  MissionDuration: 'prismx_mission_duration_ms',
  WorkerExecutions: 'prismx_worker_executions_total',
  WorkerDuration: 'prismx_worker_execution_duration_ms',
  ProviderCalls: 'prismx_provider_calls_total',
  ProviderErrors: 'prismx_provider_errors_total',
  TokensUsed: 'prismx_tokens_total',
  CostUsd: 'prismx_cost_usd_total',
  QueueDepth: 'prismx_queue_depth',
  DeadLetters: 'prismx_dead_letters',
  CacheHits: 'prismx_cache_hits_total',
  CacheMisses: 'prismx_cache_misses_total',
  DatabaseLatency: 'prismx_database_latency_ms',
  InstancesHealthy: 'prismx_instances_healthy',
  ProcessMemoryMb: 'prismx_process_memory_mb',
  ProcessCpuPercent: 'prismx_process_cpu_percent',
  RateLimited: 'prismx_rate_limited_total',
  AuthFailures: 'prismx_auth_failures_total',
  ExtensionHostCalls: 'prismx_extension_host_calls_total',
} as const;
