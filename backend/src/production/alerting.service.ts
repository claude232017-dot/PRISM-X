import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AlertEvent, AlertRule, AlertSeverity } from '@prisma/client';
import {
  AlertEventRepository,
  AlertRuleRepository,
} from '../database/repositories/production.repositories';
import { Metric, MetricsService } from './metrics.service';
import { InstanceService } from './instance.service';

/**
 * Alert evaluation.
 *
 * Dashboards answer questions someone thought to ask. Alerts are for the ones
 * nobody is awake to ask, which makes two properties matter more than the rule
 * language:
 *
 * **A condition must hold before it fires.** `forSeconds` exists so that a
 * single slow request does not page anyone. A rule that fires on one sample
 * trains people to ignore it, and an ignored alert is worse than none because
 * it costs attention without buying anything.
 *
 * **Firing is idempotent.** One open event per rule, resolved when the
 * condition clears. Without that, a metric hovering at the threshold produces
 * an event per evaluation, which is how an alerting system becomes a denial of
 * service against its own operators.
 *
 * Evaluation runs only on the lease holder. Every instance evaluating would
 * multiply both the writes and the notifications by the instance count.
 */
@Injectable()
export class AlertingService implements OnModuleInit {
  private readonly logger = new Logger(AlertingService.name);

  /** rule key → when the condition first became true. */
  private readonly pending = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  private static readonly EVALUATE_MS = 30_000;

  constructor(
    private readonly rules: AlertRuleRepository,
    private readonly events: AlertEventRepository,
    private readonly metrics: MetricsService,
    private readonly instances: InstanceService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaults();
    this.timer = setInterval(() => {
      void this.instances.runIfLeader('alert-evaluation', () => this.evaluateAll());
    }, AlertingService.EVALUATE_MS);
    this.timer.unref?.();
  }

  /**
   * The rules a production deployment should have on day one.
   *
   * Seeded rather than documented, and upserted by key so an operator's edits
   * to threshold or severity survive a restart — a default that silently
   * reverts a tuned threshold is a default that gets deleted.
   */
  private async seedDefaults(): Promise<void> {
    const defaults: Array<Parameters<AlertRuleRepository['upsert']>[1] & { key: string }> = [
      {
        key: 'api_error_rate',
        name: 'API error rate',
        description: 'Server errors as a share of all requests.',
        metric: 'derived:error_rate',
        comparison: 'gt',
        threshold: 0.05,
        forSeconds: 120,
        severity: 'CRITICAL',
      },
      {
        key: 'api_latency_p95',
        name: 'API latency (p95)',
        description: '95th percentile request duration.',
        metric: `percentile:${Metric.HttpDuration}:0.95`,
        comparison: 'gt',
        threshold: 2000,
        forSeconds: 300,
        severity: 'WARNING',
      },
      {
        key: 'dead_letters',
        name: 'Dead-letter accumulation',
        description: 'Work the system accepted and then failed to do.',
        metric: Metric.DeadLetters,
        comparison: 'gt',
        threshold: 10,
        forSeconds: 300,
        severity: 'WARNING',
      },
      {
        key: 'provider_errors',
        name: 'Provider failures',
        description: 'Failed calls to intelligence providers.',
        metric: Metric.ProviderErrors,
        comparison: 'gt',
        threshold: 25,
        forSeconds: 300,
        severity: 'WARNING',
      },
      {
        key: 'no_healthy_instances',
        name: 'Instance availability',
        description: 'Fewer than two instances are serving traffic.',
        metric: Metric.InstancesHealthy,
        comparison: 'lt',
        threshold: 2,
        forSeconds: 180,
        severity: 'WARNING',
      },
      {
        key: 'memory_pressure',
        name: 'Process memory',
        description: 'Resident memory for this process.',
        metric: Metric.ProcessMemoryMb,
        comparison: 'gt',
        threshold: 1536,
        forSeconds: 300,
        severity: 'WARNING',
      },
      {
        key: 'auth_failures',
        name: 'Authentication failures',
        description: 'Rejected credentials — the shape of credential stuffing.',
        metric: Metric.AuthFailures,
        comparison: 'gt',
        threshold: 100,
        forSeconds: 300,
        severity: 'CRITICAL',
      },
      {
        key: 'extension_denials',
        name: 'Extension capability denials',
        description: 'Extensions reaching for capabilities they were not granted.',
        metric: 'derived:extension_denials',
        comparison: 'gt',
        threshold: 50,
        forSeconds: 600,
        severity: 'WARNING',
      },
    ];

    for (const { key, ...rule } of defaults) {
      const existing = await this.rules.find(key);
      if (existing) continue; // Never overwrite a tuned rule.
      await this.rules.upsert(key, rule);
    }
    this.logger.log(`${defaults.length} alert rules available`);
  }

  /** Resolves a rule's metric expression against the registry. */
  private measure(rule: AlertRule): number | null {
    const metric = rule.metric;

    if (metric.startsWith('percentile:')) {
      const [, name, quantile] = metric.split(':');
      return this.metrics.percentile(name, Number(quantile) || 0.95);
    }

    if (metric === 'derived:error_rate') {
      const total = this.metrics.total(Metric.HttpRequests);
      // Below a floor the ratio is noise: one failure in three requests is 33%
      // and means nothing. Returning null makes the rule abstain rather than
      // page someone about a sample size of three.
      if (total < 20) return null;
      return this.metrics.total(Metric.HttpErrors) / total;
    }

    if (metric === 'derived:extension_denials') {
      return this.metrics.value(Metric.ExtensionHostCalls, { decision: 'DENIED' }) ?? 0;
    }

    return this.metrics.total(metric) || this.metrics.value(metric);
  }

  private static breached(value: number, comparison: string, threshold: number): boolean {
    switch (comparison) {
      case 'gte':
        return value >= threshold;
      case 'lt':
        return value < threshold;
      case 'lte':
        return value <= threshold;
      default:
        return value > threshold;
    }
  }

  async evaluateAll(): Promise<{ evaluated: number; fired: number; resolved: number }> {
    const rules = await this.rules.list(true);
    let fired = 0;
    let resolved = 0;

    for (const rule of rules) {
      const outcome = await this.evaluate(rule);
      if (outcome === 'fired') fired += 1;
      if (outcome === 'resolved') resolved += 1;
    }

    return { evaluated: rules.length, fired, resolved };
  }

  private async evaluate(rule: AlertRule): Promise<'fired' | 'resolved' | 'quiet' | 'abstained'> {
    const value = this.measure(rule);
    if (value === null) {
      // Not enough data to judge. Clear any pending timer so a gap in traffic
      // does not accumulate toward a firing condition.
      this.pending.delete(rule.key);
      return 'abstained';
    }

    const open = await this.events.firing(rule.key);
    const breaching = AlertingService.breached(value, rule.comparison, rule.threshold);

    if (!breaching) {
      this.pending.delete(rule.key);
      if (open) {
        await this.events.update(open.id, { status: 'RESOLVED', resolvedAt: new Date() });
        this.logger.log(`Alert resolved: ${rule.key} (${value} vs ${rule.threshold})`);
        return 'resolved';
      }
      return 'quiet';
    }

    if (open) return 'quiet'; // Already firing; do not duplicate.

    const since = this.pending.get(rule.key);
    if (!since) {
      this.pending.set(rule.key, Date.now());
      return 'quiet';
    }
    if (Date.now() - since < rule.forSeconds * 1000) return 'quiet';

    this.pending.delete(rule.key);
    await this.events.create({
      ruleId: rule.id,
      ruleKey: rule.key,
      severity: rule.severity,
      status: 'FIRING',
      value,
      threshold: rule.threshold,
      detail: `${rule.name}: ${value} ${rule.comparison} ${rule.threshold} for ${rule.forSeconds}s`,
    });
    this.logger.warn(`Alert firing: ${rule.key} — ${value} ${rule.comparison} ${rule.threshold}`);
    return 'fired';
  }

  /** Fires a rule immediately, bypassing the dwell time. For testing a route. */
  async fireNow(key: string, value?: number): Promise<AlertEvent> {
    const rule = await this.rules.find(key);
    if (!rule) throw new Error(`No alert rule "${key}"`);
    const existing = await this.events.firing(key);
    if (existing) return existing;

    return this.events.create({
      ruleId: rule.id,
      ruleKey: rule.key,
      severity: rule.severity,
      status: 'FIRING',
      value: value ?? rule.threshold + 1,
      threshold: rule.threshold,
      detail: `${rule.name}: fired manually`,
    });
  }

  async acknowledge(id: string, userId?: string): Promise<AlertEvent> {
    return this.events.update(id, {
      status: 'ACKNOWLEDGED',
      acknowledgedAt: new Date(),
      acknowledgedById: userId ?? null,
    });
  }

  listRules(): Promise<AlertRule[]> {
    return this.rules.list();
  }

  upsertRule(key: string, data: Record<string, unknown>): Promise<AlertRule> {
    return this.rules.upsert(key, data);
  }

  firing(): Promise<AlertEvent[]> {
    return this.events.allFiring();
  }

  history(take = 100): Promise<AlertEvent[]> {
    return this.events.history(take);
  }

  async summary(): Promise<{
    rules: number;
    firing: number;
    bySeverity: Record<string, number>;
    worst: AlertSeverity | null;
  }> {
    const [rules, firing] = await Promise.all([this.rules.count(), this.events.allFiring()]);
    const bySeverity: Record<string, number> = {};
    for (const event of firing) {
      bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1;
    }
    const worst = firing.some((e) => e.severity === 'CRITICAL')
      ? 'CRITICAL'
      : firing.some((e) => e.severity === 'WARNING')
        ? 'WARNING'
        : firing.length
          ? 'INFO'
          : null;
    return { rules, firing: firing.length, bySeverity, worst: worst as AlertSeverity | null };
  }
}
