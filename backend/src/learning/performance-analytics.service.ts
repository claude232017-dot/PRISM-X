import { Injectable, Logger } from '@nestjs/common';
import {
  ExecutionLog,
  MetricPeriod,
  MetricSubject,
  PerformanceSnapshot,
} from '@prisma/client';
import { PerformanceSnapshotRepository } from '../database/repositories/learning.repositories';
import { ExecutionLogRepository } from '../database/repositories/execution.repositories';
import {
  ProviderRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import {
  WorkflowRepository,
  WorkflowRunRepository,
} from '../database/repositories/automation.repositories';
import { MissionReviewRepository } from '../database/repositories/learning.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import * as Confidence from './confidence';

export interface TrendPoint {
  periodStart: string;
  successRate: number;
  avgDurationMs: number;
  avgCostUsd: number;
  samples: number;
}

export interface Trend {
  subject: MetricSubject;
  subjectId: string;
  subjectLabel: string;
  points: TrendPoint[];
  /** Change in success rate between the first and last window with data. */
  direction: 'improving' | 'declining' | 'steady' | 'unknown';
  change: number;
  confidence: number;
  summary: string;
}

/**
 * What the platform's history says about how well things work.
 *
 * Two decisions shape everything here.
 *
 * **Rates are Wilson lower bounds, not raw proportions.** A worker with three
 * successes out of three observes 100% and is not better than one with 480
 * out of 500. Sorting by the observed rate would put the first on top, and
 * every recommendation built on that ordering would be chasing noise. The
 * raw figure is kept alongside as `observedRate` so nothing is hidden — but
 * the column the system *ranks* by is the conservative one.
 *
 * **Trends are derived from snapshots, never stored.** A trend is a
 * relationship between measurements; storing it as its own column would let
 * it drift out of agreement with the measurements it claims to summarise.
 */
@Injectable()
export class PerformanceAnalyticsService {
  private readonly logger = new Logger(PerformanceAnalyticsService.name);

  /** Periods below this many samples are reported but not ranked. */
  static readonly MIN_RANKABLE_SAMPLES = 5;

  constructor(
    private readonly snapshots: PerformanceSnapshotRepository,
    private readonly executionLogs: ExecutionLogRepository,
    private readonly workers: WorkerRepository,
    private readonly providers: ProviderRepository,
    private readonly workflows: WorkflowRepository,
    private readonly workflowRuns: WorkflowRunRepository,
    private readonly reviews: MissionReviewRepository,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Rollups
  // ----------------------------------------------------------------

  /**
   * Recomputes every subject's metrics for the period containing `at`.
   *
   * Recomputation converges rather than accumulating — running this twice
   * for the same window produces the same numbers, because the snapshot is
   * keyed on (subject, id, period, start) and rewritten in place.
   */
  async rollup(
    period: MetricPeriod = MetricPeriod.DAY,
    at = new Date(),
  ): Promise<{ written: number; period: MetricPeriod; periodStart: Date }> {
    const periodStart = PerformanceAnalyticsService.periodStart(period, at);
    const periodEnd = PerformanceAnalyticsService.periodEnd(period, periodStart);

    const logs = await this.executionLogs.findMany(
      { startedAt: { gte: periodStart, lt: periodEnd } },
      { take: 5000, orderBy: { startedAt: 'desc' } },
    );

    let written = 0;
    written += await this.rollupWorkers(logs, period, periodStart);
    written += await this.rollupProviders(logs, period, periodStart);
    written += await this.rollupWorkflows(period, periodStart, periodEnd);
    written += await this.rollupOrganization(logs, period, periodStart, periodEnd);

    await this.events.publish(DomainEvent.PerformanceSnapshotTaken, {
      period,
      periodStart: periodStart.toISOString(),
      snapshots: written,
    });

    return { written, period, periodStart };
  }

  private async rollupWorkers(
    logs: ExecutionLog[],
    period: MetricPeriod,
    periodStart: Date,
  ): Promise<number> {
    const byWorker = PerformanceAnalyticsService.groupBy(
      logs.filter((l) => l.workerId),
      (l) => l.workerId!,
    );

    let written = 0;
    for (const [workerId, group] of byWorker) {
      const worker = await this.workers.findById(workerId);
      const metrics = PerformanceAnalyticsService.metricsFor(group);

      await this.snapshots.record({
        subject: MetricSubject.WORKER,
        subjectId: workerId,
        subjectLabel: worker?.name ?? workerId,
        period,
        periodStart,
        metrics: {
          ...metrics,
          // Quality for a worker is doing the job without needing help:
          // succeeding, without retries, without denied tool calls.
          qualityScore: PerformanceAnalyticsService.qualityOf(group),
        },
      });
      written += 1;
    }
    return written;
  }

  private async rollupProviders(
    logs: ExecutionLog[],
    period: MetricPeriod,
    periodStart: Date,
  ): Promise<number> {
    const byProvider = PerformanceAnalyticsService.groupBy(
      logs.filter((l) => l.providerId),
      (l) => l.providerId!,
    );

    let written = 0;
    for (const [providerId, group] of byProvider) {
      const provider = await this.providers.findById(providerId);
      const metrics = PerformanceAnalyticsService.metricsFor(group);

      await this.snapshots.record({
        subject: MetricSubject.PROVIDER,
        subjectId: providerId,
        subjectLabel: provider?.name ?? providerId,
        period,
        periodStart,
        metrics: {
          ...metrics,
          // A provider's quality is reliability and speed; it has no view of
          // whether the answer was any good, so claiming one would be a lie.
          qualityScore: Number(
            (metrics.successRate * 0.7 + (1 - Math.min(1, metrics.avgLatencyMs / 30_000)) * 0.3).toFixed(4),
          ),
          detail: {
            models: [...new Set(group.map((l) => l.model).filter(Boolean))],
            kind: provider?.kind ?? null,
          },
        },
      });
      written += 1;
    }
    return written;
  }

  private async rollupWorkflows(
    period: MetricPeriod,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    const runs = await this.workflowRuns.findMany(
      { startedAt: { gte: periodStart, lt: periodEnd } },
      { take: 2000, orderBy: { startedAt: 'desc' } },
    );

    const byWorkflow = PerformanceAnalyticsService.groupBy(runs, (r) => r.workflowId);

    let written = 0;
    for (const [workflowId, group] of byWorkflow) {
      const workflow = await this.workflows.findById(workflowId);
      const samples = group.length;
      const successes = group.filter((r) => r.status === 'SUCCEEDED').length;
      // `durationMs` is recorded by the engine when a run settles; falling
      // back to the timestamps only covers runs that never finished.
      const durations = group.map((r) =>
        r.durationMs > 0
          ? r.durationMs
          : r.finishedAt
            ? r.finishedAt.getTime() - r.startedAt.getTime()
            : 0,
      );
      const retries = group.reduce((sum, r) => sum + Math.max(0, r.attempts - 1), 0);

      await this.snapshots.record({
        subject: MetricSubject.WORKFLOW,
        subjectId: workflowId,
        subjectLabel: workflow?.name ?? workflowId,
        period,
        periodStart,
        metrics: {
          samples,
          successes,
          failures: samples - successes,
          successRate: Confidence.wilsonLowerBound(successes, samples),
          observedRate: samples > 0 ? Number((successes / samples).toFixed(4)) : 0,
          avgDurationMs: PerformanceAnalyticsService.mean(durations),
          p95DurationMs: PerformanceAnalyticsService.percentile(durations, 0.95),
          totalCostUsd: Number(group.reduce((s, r) => s + r.costUsd, 0).toFixed(6)),
          avgCostUsd:
            samples > 0
              ? Number((group.reduce((s, r) => s + r.costUsd, 0) / samples).toFixed(6))
              : 0,
          retryRate: samples > 0 ? Number((retries / samples).toFixed(4)) : 0,
          errorRate: samples > 0 ? Number(((samples - successes) / samples).toFixed(4)) : 0,
          qualityScore: Confidence.wilsonLowerBound(successes, samples),
          confidence: Confidence.score({
            samples,
            consistency: Confidence.consistencyOf(durations),
          }).value,
        },
      });
      written += 1;
    }
    return written;
  }

  private async rollupOrganization(
    logs: ExecutionLog[],
    period: MetricPeriod,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    const [reviews, runs] = await Promise.all([
      this.reviews.findMany(
        { createdAt: { gte: periodStart, lt: periodEnd } },
        { take: 1000 },
      ),
      this.workflowRuns.findMany(
        { startedAt: { gte: periodStart, lt: periodEnd } },
        { take: 2000 },
      ),
    ]);

    const metrics = PerformanceAnalyticsService.metricsFor(logs);
    const missionsCompleted = reviews.filter((r) => r.outcome === 'SUCCESS').length;
    const humanTouched = reviews.filter((r) => r.humanInterventions > 0).length;

    await this.snapshots.record({
      subject: MetricSubject.ORGANIZATION,
      subjectId: 'organization',
      subjectLabel: 'Organization',
      period,
      periodStart,
      metrics: {
        ...metrics,
        qualityScore:
          reviews.length > 0
            ? Number(
                (reviews.reduce((s, r) => s + r.successScore, 0) / reviews.length).toFixed(4),
              )
            : 0,
        detail: {
          missionsReviewed: reviews.length,
          missionsCompleted,
          workflowRuns: runs.length,
          // What share of finished work needed nobody. The honest reading of
          // "automation coverage": not how much is automated in principle,
          // but how much actually ran without a person in the loop.
          automationCoverage:
            reviews.length > 0
              ? Number(((reviews.length - humanTouched) / reviews.length).toFixed(4))
              : 0,
          humanTouchedMissions: humanTouched,
          aiSpendUsd: metrics.totalCostUsd,
          // Completed missions per dollar — the only productivity figure the
          // system can actually observe.
          productivity:
            metrics.totalCostUsd > 0
              ? Number((missionsCompleted / metrics.totalCostUsd).toFixed(4))
              : 0,
        },
      },
    });
    return 1;
  }

  // ----------------------------------------------------------------
  // Reading
  // ----------------------------------------------------------------

  async series(
    subject: MetricSubject,
    subjectId: string,
    period: MetricPeriod = MetricPeriod.DAY,
    take = 30,
  ): Promise<PerformanceSnapshot[]> {
    return this.snapshots.series(subject, subjectId, period, take);
  }

  async leaderboard(
    subject: MetricSubject,
    period: MetricPeriod = MetricPeriod.DAY,
    take = 10,
  ): Promise<Array<PerformanceSnapshot & { rankable: boolean }>> {
    const rows = await this.snapshots.latestFor(subject, period, 200);

    // One row per subject — the most recent period it appears in.
    const latest = new Map<string, PerformanceSnapshot>();
    for (const row of rows) {
      const seen = latest.get(row.subjectId);
      if (!seen || row.periodStart > seen.periodStart) latest.set(row.subjectId, row);
    }

    return [...latest.values()]
      .map((row) => ({
        ...row,
        // Thin evidence is shown but flagged, rather than silently ranked
        // among figures that mean far more.
        rankable: row.samples >= PerformanceAnalyticsService.MIN_RANKABLE_SAMPLES,
      }))
      .sort((a, b) => {
        if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
        return b.successRate - a.successRate || b.qualityScore - a.qualityScore;
      })
      .slice(0, take);
  }

  /**
   * Derives a trend by comparing the oldest and newest periods with data.
   *
   * Reported as `unknown` rather than `steady` when there is too little to
   * compare — those are different statements, and collapsing them would let
   * "we have no idea" be read as "nothing is changing".
   */
  async trend(
    subject: MetricSubject,
    subjectId: string,
    period: MetricPeriod = MetricPeriod.DAY,
    windows = 14,
  ): Promise<Trend> {
    const rows = (await this.snapshots.series(subject, subjectId, period, windows)).reverse();

    const points: TrendPoint[] = rows.map((row) => ({
      periodStart: row.periodStart.toISOString(),
      successRate: row.successRate,
      avgDurationMs: row.avgDurationMs,
      avgCostUsd: row.avgCostUsd,
      samples: row.samples,
    }));

    const label = rows[0]?.subjectLabel ?? subjectId;
    const withData = rows.filter((r) => r.samples > 0);

    if (withData.length < 2) {
      return {
        subject,
        subjectId,
        subjectLabel: label,
        points,
        direction: 'unknown',
        change: 0,
        confidence: 0,
        summary: `Not enough history yet — ${withData.length} period(s) with data.`,
      };
    }

    const first = withData[0];
    const last = withData[withData.length - 1];
    const change = Number((last.successRate - first.successRate).toFixed(4));
    const totalSamples = withData.reduce((sum, r) => sum + r.samples, 0);

    const confidence = Confidence.score({
      samples: totalSamples,
      consistency: Confidence.consistencyOf(withData.map((r) => r.successRate)),
    });

    // A threshold, because tiny movements in a rate are noise and calling
    // them a direction would have the dashboard reporting a new trend daily.
    const direction =
      Math.abs(change) < 0.05 ? 'steady' : change > 0 ? 'improving' : 'declining';

    return {
      subject,
      subjectId,
      subjectLabel: label,
      points,
      direction,
      change,
      confidence: confidence.value,
      summary:
        `${label}: success rate ${direction} by ${(Math.abs(change) * 100).toFixed(1)} points ` +
        `across ${withData.length} periods. ${confidence.rationale}`,
    };
  }

  // ----------------------------------------------------------------
  // Pure helpers
  // ----------------------------------------------------------------

  static metricsFor(logs: ExecutionLog[]) {
    const samples = logs.length;
    const successes = logs.filter((l) => l.status === 'SUCCEEDED').length;
    const failures = samples - successes;
    const durations = logs.map((l) => l.latencyMs).filter((n) => n > 0);
    const totalCostUsd = Number(logs.reduce((s, l) => s + l.costUsd, 0).toFixed(6));
    const retries = logs.reduce((sum, l) => sum + Math.max(0, l.attempts - 1), 0);

    return {
      samples,
      successes,
      failures,
      successRate: Confidence.wilsonLowerBound(successes, samples),
      observedRate: samples > 0 ? Number((successes / samples).toFixed(4)) : 0,
      avgDurationMs: PerformanceAnalyticsService.mean(durations),
      p95DurationMs: PerformanceAnalyticsService.percentile(durations, 0.95),
      avgLatencyMs: PerformanceAnalyticsService.mean(durations),
      totalCostUsd,
      avgCostUsd: samples > 0 ? Number((totalCostUsd / samples).toFixed(6)) : 0,
      totalTokens: logs.reduce((s, l) => s + l.totalTokens, 0),
      retryRate: samples > 0 ? Number((retries / samples).toFixed(4)) : 0,
      errorRate: samples > 0 ? Number((failures / samples).toFixed(4)) : 0,
      // Successes per dollar. Zero spend means the figure is undefined, not
      // infinite — reporting infinity would make a free provider top every
      // efficiency ranking forever.
      costEfficiency: totalCostUsd > 0 ? Number((successes / totalCostUsd).toFixed(4)) : 0,
      confidence: Confidence.score({
        samples,
        consistency: Confidence.consistencyOf(durations),
      }).value,
    };
  }

  /** Succeeded, first time, without asking for tools it could not have. */
  static qualityOf(logs: ExecutionLog[]): number {
    if (logs.length === 0) return 0;
    const clean = logs.filter((l) => l.status === 'SUCCEEDED' && l.attempts <= 1).length;
    return Number((clean / logs.length).toFixed(4));
  }

  static mean(values: number[]): number {
    if (values.length === 0) return 0;
    return Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(2));
  }

  static percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    // Nearest-rank: with few samples an interpolated percentile invents a
    // value that was never observed, which is exactly the wrong move for a
    // latency figure someone is about to set an alert on.
    const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
    return Number(sorted[Math.max(0, index)].toFixed(2));
  }

  static groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
      const k = key(row);
      const bucket = groups.get(k);
      if (bucket) bucket.push(row);
      else groups.set(k, [row]);
    }
    return groups;
  }

  static periodStart(period: MetricPeriod, at: Date): Date {
    const d = new Date(at);
    d.setUTCMilliseconds(0);
    d.setUTCSeconds(0);
    d.setUTCMinutes(0);
    if (period === MetricPeriod.HOUR) return d;

    d.setUTCHours(0);
    if (period === MetricPeriod.DAY) return d;

    if (period === MetricPeriod.WEEK) {
      // ISO weeks start Monday; getUTCDay() calls Sunday 0, so Sunday has to
      // count as the seventh day rather than the first or the week boundary
      // lands a day early.
      const weekday = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - weekday);
      return d;
    }

    d.setUTCDate(1);
    return d;
  }

  static periodEnd(period: MetricPeriod, start: Date): Date {
    const d = new Date(start);
    switch (period) {
      case MetricPeriod.HOUR:
        d.setUTCHours(d.getUTCHours() + 1);
        break;
      case MetricPeriod.DAY:
        d.setUTCDate(d.getUTCDate() + 1);
        break;
      case MetricPeriod.WEEK:
        d.setUTCDate(d.getUTCDate() + 7);
        break;
      default:
        d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return d;
  }
}
