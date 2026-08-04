import { Injectable, Logger } from '@nestjs/common';
import {
  AdapterExecutionContext,
  AdapterResult,
  IExecutionAdapter,
  WorkflowStep,
  WorkflowStepError,
} from './execution-adapter.contract';
import { IntegrationManager } from '../../integrations/integration-manager.service';
import { WorkerRuntimeService } from '../../workers/runtime/worker-runtime.service';
import { MissionsService } from '../../missions/missions.service';
import { MissionOrchestrator } from '../../missions/orchestrator/mission-orchestrator.service';
import {
  MAX_WAIT_SECONDS,
  MissionQueueService,
} from '../../missions/orchestrator/mission-queue.service';
import type { MissionRunResult } from '../../missions/orchestrator/mission-orchestrator.service';
import { resolveTemplate } from '../../integrations/connectors/http-connector';

/**
 * Runs steps inside PRISM-X itself: workers, integrations, missions, HTTP.
 *
 * This is the default runtime and the only one with no external dependency,
 * which is why the engine falls back to it whenever a step names no adapter.
 */
@Injectable()
export class InternalExecutionAdapter implements IExecutionAdapter {
  readonly key = 'internal';
  readonly displayName = 'PRISM-X Internal';
  readonly supports = ['worker', 'integration', 'mission', 'http', 'transform', 'noop'];

  private readonly logger = new Logger(InternalExecutionAdapter.name);

  constructor(
    private readonly workers: WorkerRuntimeService,
    private readonly integrations: IntegrationManager,
    private readonly missions: MissionsService,
    private readonly orchestrator: MissionOrchestrator,
    private readonly missionQueue: MissionQueueService,
  ) {}

  async execute(step: WorkflowStep, ctx: AdapterExecutionContext): Promise<AdapterResult> {
    const config = resolveTemplate(step.config, {
      ...ctx.input,
      ...ctx.context,
      input: ctx.input,
      context: ctx.context,
    });

    switch (step.type) {
      case 'worker':
        return this.runWorker(config);
      case 'integration':
        return this.callIntegration(config);
      case 'mission':
        return this.runMission(config);
      case 'http':
        return this.callHttp(config);
      case 'transform':
        // Pure data shaping: the resolved config *is* the output.
        return { ok: true, output: config };
      case 'noop':
        return { ok: true, output: {} };
      default:
        throw new WorkflowStepError(
          `Internal adapter cannot execute step type "${step.type}"`,
        );
    }
  }

  private async runWorker(config: Record<string, unknown>): Promise<AdapterResult> {
    const workerId = String(config.workerId ?? '');
    const instruction = String(config.instruction ?? '');
    if (!workerId || !instruction) {
      throw new WorkflowStepError('A worker step needs `workerId` and `instruction`');
    }

    const result = await this.workers.execute({
      workerId,
      instruction,
      context: config.context ? String(config.context) : undefined,
      missionId: config.missionId ? String(config.missionId) : undefined,
    });

    return {
      ok: result.status === 'SUCCEEDED',
      output: {
        output: result.output,
        model: result.model,
        toolCalls: result.toolCalls.length,
      },
      error: result.error,
      costUsd: result.costUsd,
      totalTokens: result.totalTokens,
    };
  }

  private async callIntegration(config: Record<string, unknown>): Promise<AdapterResult> {
    const integrationId = String(config.integrationId ?? '');
    const action = String(config.action ?? '');
    if (!integrationId || !action) {
      throw new WorkflowStepError('An integration step needs `integrationId` and `action`');
    }

    const result = await this.integrations.execute(
      integrationId,
      action,
      (config.input as Record<string, unknown>) ?? {},
    );

    return {
      ok: result.ok,
      output: result.data,
      error: result.error,
      externalRunId: result.externalId,
    };
  }

  private async runMission(config: Record<string, unknown>): Promise<AdapterResult> {
    const missionId = config.missionId ? String(config.missionId) : null;

    // Either drive an existing mission or create one from the step config.
    const mission = missionId
      ? { id: missionId }
      : await this.missions.create({
          title: String(config.title ?? 'Workflow mission'),
          objective: String(config.objective ?? 'Created by a workflow'),
          tasks: (config.tasks as never) ?? [],
        });

    // Queued like every other execution, then waited on. A workflow step needs
    // the mission's output before the next step can run, so it does block — but
    // the mission runs on a queue worker with its retries and its concurrency
    // ceiling, rather than inside whatever is driving the workflow.
    const outcome = await this.missionQueue.enqueue(mission.id, {
      waitSeconds: MAX_WAIT_SECONDS,
    });

    if ('accepted' in outcome) {
      // The wait expired. The mission is still running; the step reports that
      // honestly rather than claiming a failure or a success.
      return {
        ok: false,
        output: outcome,
        error:
          `Mission ${mission.id} is still running after ${MAX_WAIT_SECONDS}s — ` +
          'poll it rather than treating this step as failed',
      };
    }

    const run = outcome as MissionRunResult;
    return {
      ok: run.status === 'COMPLETED',
      output: run,
      error: run.status === 'COMPLETED' ? undefined : `Mission ended ${run.status}`,
      costUsd: run.totalCostUsd,
      totalTokens: run.totalTokens,
    };
  }

  private async callHttp(config: Record<string, unknown>): Promise<AdapterResult> {
    const url = String(config.url ?? '');
    if (!url) throw new WorkflowStepError('An http step needs `url`');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(config.timeoutMs ?? 30_000));

    try {
      const response = await fetch(url, {
        method: String(config.method ?? 'POST'),
        headers: {
          'content-type': 'application/json',
          ...((config.headers as Record<string, string>) ?? {}),
        },
        body: config.body === undefined ? undefined : JSON.stringify(config.body),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }

      return {
        ok: response.ok,
        output: { status: response.status, body: parsed },
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      throw new WorkflowStepError(
        `HTTP step failed: ${(error as Error).message}`,
        // Network-level failures are worth another attempt.
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return { healthy: true, message: 'In-process adapter' };
  }
}

/**
 * Base for adapters that hand work to an external automation runtime.
 *
 * The pattern is the same for n8n, Make and anything similar: POST the payload
 * to a runtime-specific URL, treat a 2xx as accepted, and record the external
 * identifier so a run can be traced across both systems.
 */
abstract class WebhookRuntimeAdapter implements IExecutionAdapter {
  abstract readonly key: string;
  abstract readonly displayName: string;
  abstract readonly supports: string[];
  protected abstract urlFrom(config: Record<string, unknown>): string;

  protected readonly logger = new Logger(this.constructor.name);

  async execute(step: WorkflowStep, ctx: AdapterExecutionContext): Promise<AdapterResult> {
    const config = resolveTemplate(step.config, {
      ...ctx.input,
      ...ctx.context,
      input: ctx.input,
      context: ctx.context,
    });

    const url = this.urlFrom(config);
    if (!url) {
      throw new WorkflowStepError(
        `A ${this.displayName} step needs a webhook URL in its config`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(config.timeoutMs ?? 60_000));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Lets the receiving runtime correlate back to the PRISM-X run.
          'x-prismx-run-id': ctx.runId,
          'x-prismx-step-id': ctx.stepId,
          'x-prismx-workflow-id': ctx.workflowId,
          ...((config.headers as Record<string, string>) ?? {}),
        },
        body: JSON.stringify({
          runId: ctx.runId,
          stepId: ctx.stepId,
          workflowId: ctx.workflowId,
          input: config.payload ?? config.input ?? ctx.input,
          context: ctx.context,
        }),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        parsed = { raw: text };
      }

      if (!response.ok) {
        return {
          ok: false,
          error: `${this.displayName} returned ${response.status}: ${text.slice(0, 200)}`,
          output: parsed,
        };
      }

      return {
        ok: true,
        output: parsed,
        externalRunId:
          (parsed.executionId as string) ?? (parsed.id as string) ?? undefined,
      };
    } catch (error) {
      throw new WorkflowStepError(
        `${this.displayName} call failed: ${(error as Error).message}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    // There is no single endpoint to probe — each step names its own URL — so
    // health is reported per-step at execution time rather than globally.
    return {
      healthy: true,
      message: `${this.displayName} adapter ready; each step supplies its own URL`,
    };
  }
}

/** Delegates a step to an n8n workflow via its webhook trigger. */
@Injectable()
export class N8nExecutionAdapter extends WebhookRuntimeAdapter {
  readonly key = 'n8n';
  readonly displayName = 'n8n';
  readonly supports = ['n8n'];

  protected urlFrom(config: Record<string, unknown>): string {
    // Either a full webhook URL, or base + path.
    if (config.webhookUrl) return String(config.webhookUrl);
    if (config.baseUrl && config.webhookPath) {
      return `${String(config.baseUrl).replace(/\/+$/, '')}/webhook/${String(
        config.webhookPath,
      ).replace(/^\/+/, '')}`;
    }
    return '';
  }
}

/** Delegates a step to a Make.com scenario via its custom webhook. */
@Injectable()
export class MakeExecutionAdapter extends WebhookRuntimeAdapter {
  readonly key = 'make';
  readonly displayName = 'Make.com';
  readonly supports = ['make'];

  protected urlFrom(config: Record<string, unknown>): string {
    return String(config.webhookUrl ?? config.hookUrl ?? '');
  }
}
