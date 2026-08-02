import { Injectable } from '@nestjs/common';
import {
  DeadLetterRepository,
  WorkflowRepository,
  WorkflowRunRepository,
} from '../database/repositories/automation.repositories';
import { IntegrationRepository } from '../database/repositories/tenant.repositories';
import { ExecutionLogRepository } from '../database/repositories/execution.repositories';
import { WebhookDispatcher } from '../public-api/webhook-dispatcher.service';

export interface SavingsAssumptions {
  /** Human minutes a single run is assumed to replace. */
  minutesSavedPerRun?: number;
  hourlyRateUsd?: number;
}

/**
 * Automation analytics.
 *
 * Two kinds of number live here and they are labelled differently on purpose:
 *
 *  - **Measured** — execution counts, success and failure rates, durations,
 *    token usage and AI cost. These come from recorded rows.
 *  - **Estimated** — hours saved, savings in currency, ROI. These rest on an
 *    operator-supplied assumption about how long the automated work would have
 *    taken a person. That assumption is returned alongside every estimate, so
 *    nobody mistakes a modelled figure for a measured one.
 */
@Injectable()
export class AutomationAnalyticsService {
  private static readonly DEFAULT_MINUTES_PER_RUN = 10;
  private static readonly DEFAULT_HOURLY_RATE = 50;

  constructor(
    private readonly runs: WorkflowRunRepository,
    private readonly workflows: WorkflowRepository,
    private readonly integrations: IntegrationRepository,
    private readonly executionLogs: ExecutionLogRepository,
    private readonly deadLetters: DeadLetterRepository,
    private readonly webhooks: WebhookDispatcher,
  ) {}

  async overview(assumptions: SavingsAssumptions = {}) {
    const minutesSavedPerRun =
      assumptions.minutesSavedPerRun ?? AutomationAnalyticsService.DEFAULT_MINUTES_PER_RUN;
    const hourlyRateUsd =
      assumptions.hourlyRateUsd ?? AutomationAnalyticsService.DEFAULT_HOURLY_RATE;

    const [metrics, byWorkflow, workflows, integrations, byWorker] = await Promise.all([
      this.runs.metrics(),
      this.runs.groupByWorkflow(),
      this.workflows.findMany({}, { take: 200 }),
      this.integrations.findMany({}, { take: 100 }),
      this.executionLogs.groupBy('workerId'),
    ]);

    const names = new Map(workflows.map((w) => [w.id, w.name]));

    // Only successful runs are credited with saving anything — a failed
    // automation did not replace human work, it created some.
    const humanHoursSaved = (metrics.succeeded * minutesSavedPerRun) / 60;
    const estimatedSavingsUsd = Math.round(humanHoursSaved * hourlyRateUsd * 100) / 100;
    const roi =
      metrics.aiCostUsd > 0
        ? Math.round(((estimatedSavingsUsd - metrics.aiCostUsd) / metrics.aiCostUsd) * 100)
        : null;

    return {
      ...metrics,

      mostUsedWorkflows: byWorkflow
        .map((row) => ({ ...row, name: names.get(row.workflowId) ?? 'unknown' }))
        .sort((a, b) => b.executions - a.executions)
        .slice(0, 10),

      mostUsedIntegrations: integrations
        .map((i) => ({
          integrationId: i.id,
          name: i.name,
          kind: i.kind,
          calls: i.callCount,
          failures: i.failureCount,
          avgLatencyMs: i.avgLatencyMs,
          healthy: i.healthy,
        }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 10),

      mostUsedWorkers: byWorker
        .filter((row) => row.key)
        .map((row) => ({
          workerId: row.key,
          executions: row.requests,
          costUsd: row.costUsd,
        }))
        .sort((a, b) => b.executions - a.executions)
        .slice(0, 10),

      // Modelled, not measured — the assumptions travel with the numbers.
      humanHoursSaved: Math.round(humanHoursSaved * 100) / 100,
      estimatedSavingsUsd,
      roi,
      assumptions: {
        minutesSavedPerRun,
        hourlyRateUsd,
        note:
          'Hours saved, savings and ROI are estimates derived from the assumptions ' +
          'above and the count of successful runs. Execution counts, durations, ' +
          'tokens and AI cost are measured.',
      },

      generatedAt: new Date().toISOString(),
    };
  }

  /** Everything that failed and was captured rather than dropped. */
  async reliability() {
    const [unresolved, allDeadLetters, suspended, webhookStats] = await Promise.all([
      this.deadLetters.findUnresolved(100),
      this.deadLetters.count(),
      this.runs.findSuspended(),
      this.webhooks.statistics(),
    ]);

    return {
      deadLetters: {
        unresolved: unresolved.length,
        total: allDeadLetters,
        bySource: countBy(unresolved, (d) => d.source),
      },
      suspendedRuns: suspended.length,
      webhooks: webhookStats,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Per-workflow breakdown for the workflow detail view. */
  async forWorkflow(workflowId: string) {
    const [metrics, workflow] = await Promise.all([
      this.runs.metrics({ workflowId }),
      this.workflows.findByIdOrFail(workflowId),
    ]);
    return { workflowId, name: workflow.name, ...metrics };
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const k = key(item);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}
