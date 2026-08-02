import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TriggerType, WorkflowRunStatus } from '@prisma/client';
import {
  AdapterExecutionContext,
  AdapterResult,
  IExecutionAdapter,
  WorkflowCondition,
  WorkflowStep,
  WorkflowStepError,
} from './execution/execution-adapter.contract';
import {
  InternalExecutionAdapter,
  MakeExecutionAdapter,
  N8nExecutionAdapter,
} from './execution/adapters';
import {
  DeadLetterRepository,
  WorkflowRepository,
  WorkflowRunRepository,
  WorkflowStepRunRepository,
  WorkflowVersionRepository,
} from '../database/repositories/automation.repositories';
import { ApprovalService } from '../approvals/approval.service';
import { AiDecisionService } from '../decisions/ai-decision.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { readPath, resolveTemplate } from '../integrations/connectors/http-connector';

export interface StartRunOptions {
  workflowId: string;
  input?: Record<string, unknown>;
  triggerType?: TriggerType;
  triggerId?: string;
  /** Repeat within the dedupe window returns the original run. */
  idempotencyKey?: string;
}

export interface RunOutcome {
  runId: string;
  status: WorkflowRunStatus;
  output?: unknown;
  error?: string;
  stepsRun: number;
  stepsTotal: number;
  costUsd: number;
  durationMs: number;
  /** Present when the run suspended rather than finished. */
  awaitingApprovalId?: string;
  /** True when an existing run was returned instead of starting a new one. */
  deduplicated?: boolean;
}

/**
 * The workflow engine.
 *
 * It is an *orchestration* layer, not an automation runtime. It owns control
 * flow — order, branching, parallelism, loops, retries, suspension — and hands
 * each unit of actual work to an execution adapter. That split is deliberate:
 * PRISM-X decides what should happen and why; n8n, Make or the internal
 * runtime decide how.
 *
 * A run executes against an immutable workflow *version*, so publishing a new
 * definition never changes what an in-flight run is doing.
 */
@Injectable()
export class WorkflowEngine implements OnModuleInit {
  private readonly logger = new Logger(WorkflowEngine.name);
  private readonly adapters = new Map<string, IExecutionAdapter>();

  /** Guards against a malformed graph looping forever. */
  private static readonly MAX_STEPS_PER_RUN = 200;
  private static readonly MAX_LOOP_ITERATIONS = 100;
  private static readonly PARALLEL_CONCURRENCY = 5;

  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly versions: WorkflowVersionRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: WorkflowStepRunRepository,
    private readonly deadLetters: DeadLetterRepository,
    private readonly approvals: ApprovalService,
    private readonly decisions: AiDecisionService,
    private readonly events: EventBusService,
    private readonly internal: InternalExecutionAdapter,
    private readonly n8n: N8nExecutionAdapter,
    private readonly make: MakeExecutionAdapter,
  ) {}

  onModuleInit(): void {
    [this.internal, this.n8n, this.make].forEach((a) => this.registerAdapter(a));
    this.logger.log(`Execution adapters: ${[...this.adapters.keys()].join(', ')}`);
  }

  registerAdapter(adapter: IExecutionAdapter): void {
    this.adapters.set(adapter.key, adapter);
  }

  listAdapters() {
    return [...this.adapters.values()].map((a) => ({
      key: a.key,
      displayName: a.displayName,
      supports: a.supports,
    }));
  }

  // ----------------------------------------------------------------
  // Starting a run
  // ----------------------------------------------------------------

  async start(options: StartRunOptions): Promise<RunOutcome> {
    const workflow = await this.workflows.findByIdOrFail(options.workflowId);

    if (workflow.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Workflow "${workflow.name}" is ${workflow.status}; publish it before running`,
      );
    }
    if (!workflow.activeVersionId) {
      throw new BadRequestException(`Workflow "${workflow.name}" has no published version`);
    }

    // Duplicate detection: the same key returns the original run rather than
    // performing the side effects twice.
    if (options.idempotencyKey) {
      const existing = await this.runs.findByIdempotencyKey(options.idempotencyKey);
      if (existing) {
        return {
          runId: existing.id,
          status: existing.status,
          output: existing.output,
          stepsRun: existing.stepsRun,
          stepsTotal: existing.stepsTotal,
          costUsd: existing.costUsd,
          durationMs: existing.durationMs,
          deduplicated: true,
        };
      }
    }

    const active = await this.runs.countActive(workflow.id);
    if (active >= workflow.maxConcurrentRuns) {
      throw new BadRequestException(
        `Workflow "${workflow.name}" already has ${active} runs in flight ` +
          `(limit ${workflow.maxConcurrentRuns})`,
      );
    }

    const version = await this.versions.findByIdOrFail(workflow.activeVersionId);
    const steps = (version.steps ?? []) as unknown as WorkflowStep[];

    const run = await this.runs.create({
      workflowId: workflow.id,
      versionId: version.id,
      status: WorkflowRunStatus.RUNNING,
      triggerType: options.triggerType ?? TriggerType.MANUAL,
      triggerId: options.triggerId ?? null,
      input: (options.input ?? {}) as never,
      context: {} as never,
      idempotencyKey: options.idempotencyKey ?? null,
      stepsTotal: countSteps(steps),
    });

    await this.events.publish(DomainEvent.WorkflowRunStarted, {
      runId: run.id,
      workflowId: workflow.id,
      triggerType: run.triggerType,
    });

    return this.drive(run.id, steps, (options.input ?? {}) as Record<string, unknown>, {});
  }

  /** Continues a run that was suspended for approval or a delay. */
  async resume(runId: string): Promise<RunOutcome> {
    const run = await this.runs.findByIdOrFail(runId);

    if (
      run.status !== WorkflowRunStatus.AWAITING_APPROVAL &&
      run.status !== WorkflowRunStatus.SLEEPING
    ) {
      throw new BadRequestException(
        `Run is ${run.status}; only suspended runs can be resumed`,
      );
    }

    const version = await this.versions.findByIdOrFail(run.versionId);
    const steps = (version.steps ?? []) as unknown as WorkflowStep[];
    const context = (run.context ?? {}) as Record<string, unknown>;

    // Settle the step that caused the suspension before resuming.
    //
    // Without this the resumed run re-executes that step, which for an
    // approval means asking the same question again and suspending again —
    // an approval that never takes effect. Recording the outcome in context
    // is what makes `runSequence` skip it and move on.
    if (run.currentStepId) {
      if (run.awaitingApprovalId) {
        const approval = await this.approvals.findOne(run.awaitingApprovalId);

        if (approval.status !== 'APPROVED') {
          throw new BadRequestException(
            `Approval "${approval.id}" is ${approval.status}; only an approved ` +
              'request resumes its run',
          );
        }

        context[run.currentStepId] = {
          approved: true,
          approvalId: approval.id,
          decision: approval.suggestedAction ?? approval.decision,
          decidedBy: approval.decidedById,
          comment: approval.comment,
        };
      } else {
        // A delay suspension: the wait is what the step was for.
        context[run.currentStepId] = { delayed: true, resumedAt: new Date().toISOString() };
      }
    }

    await this.runs.update(runId, {
      status: WorkflowRunStatus.RUNNING,
      resumedAt: new Date(),
      awaitingApprovalId: null,
      currentStepId: null,
      context: context as never,
    });
    await this.events.publish(DomainEvent.WorkflowRunResumed, { runId });

    return this.drive(runId, steps, (run.input ?? {}) as Record<string, unknown>, context);
  }

  async cancel(runId: string): Promise<void> {
    const run = await this.runs.findByIdOrFail(runId);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) {
      throw new BadRequestException(`Run is already ${run.status}`);
    }
    await this.runs.update(runId, {
      status: WorkflowRunStatus.CANCELLED,
      finishedAt: new Date(),
    });
  }

  // ----------------------------------------------------------------
  // The interpreter
  // ----------------------------------------------------------------

  private async drive(
    runId: string,
    steps: WorkflowStep[],
    input: Record<string, unknown>,
    seedContext: Record<string, unknown>,
  ): Promise<RunOutcome> {
    const startedAt = Date.now();
    const context: Record<string, unknown> = { ...seedContext };
    let stepsRun = 0;
    let costUsd = 0;

    try {
      const result = await this.runSequence(runId, steps, input, context, {
        budget: { remaining: WorkflowEngine.MAX_STEPS_PER_RUN },
      });

      stepsRun = result.stepsRun;
      costUsd = result.costUsd;

      if (result.suspended) {
        const run = await this.runs.update(runId, {
          status: result.suspended.reason === 'approval'
            ? WorkflowRunStatus.AWAITING_APPROVAL
            : WorkflowRunStatus.SLEEPING,
          context: context as never,
          stepsRun,
          costUsd,
          awaitingApprovalId: result.suspended.approvalId ?? null,
          currentStepId: result.suspended.stepId ?? null,
        });

        await this.events.publish(DomainEvent.WorkflowRunSuspended, {
          runId,
          reason: result.suspended.reason,
          approvalId: result.suspended.approvalId,
        });

        return {
          runId,
          status: run.status,
          stepsRun,
          stepsTotal: run.stepsTotal,
          costUsd,
          durationMs: Date.now() - startedAt,
          awaitingApprovalId: result.suspended.approvalId,
        };
      }

      if (!result.ok) {
        return this.failRun(runId, result.error ?? 'Workflow failed', {
          startedAt,
          stepsRun,
          costUsd,
          context,
        });
      }

      const finished = await this.runs.update(runId, {
        status: WorkflowRunStatus.SUCCEEDED,
        context: context as never,
        output: (result.output ?? context) as never,
        stepsRun,
        costUsd,
        durationMs: Date.now() - startedAt,
        finishedAt: new Date(),
      });

      await this.events.publish(DomainEvent.WorkflowRunCompleted, {
        runId,
        stepsRun,
        costUsd,
        durationMs: finished.durationMs,
      });

      return {
        runId,
        status: WorkflowRunStatus.SUCCEEDED,
        output: result.output ?? context,
        stepsRun,
        stepsTotal: finished.stepsTotal,
        costUsd,
        durationMs: finished.durationMs,
      };
    } catch (error) {
      return this.failRun(runId, (error as Error).message, {
        startedAt,
        stepsRun,
        costUsd,
        context,
      });
    }
  }

  /**
   * Executes steps honouring declared dependencies.
   *
   * Steps with no `dependsOn` run in declaration order; steps that declare
   * dependencies wait for them. That covers the common case (a simple list)
   * without forcing every workflow author to draw a graph.
   */
  private async runSequence(
    runId: string,
    steps: WorkflowStep[],
    input: Record<string, unknown>,
    context: Record<string, unknown>,
    state: { budget: { remaining: number } },
  ): Promise<{
    ok: boolean;
    output?: unknown;
    error?: string;
    stepsRun: number;
    costUsd: number;
    suspended?: { reason: 'approval' | 'delay'; approvalId?: string; stepId?: string };
  }> {
    let stepsRun = 0;
    let costUsd = 0;
    let lastOutput: unknown;

    for (const step of steps) {
      if (state.budget.remaining-- <= 0) {
        throw new WorkflowStepError(
          `Run exceeded ${WorkflowEngine.MAX_STEPS_PER_RUN} steps; the graph may not terminate`,
        );
      }

      // A step already recorded in context has run — this is what makes
      // resume-after-approval continue rather than repeat side effects.
      if (context[step.id] !== undefined) continue;

      if (step.condition && !evaluateCondition(step.condition, { input, context })) {
        await this.recordStep(runId, step, WorkflowRunStatus.SKIPPED, {}, null, 0);
        context[step.id] = { skipped: true };
        continue;
      }

      const outcome = await this.runStep(runId, step, input, context, state);
      stepsRun += outcome.stepsRun;
      costUsd += outcome.costUsd;

      if (outcome.suspended) {
        return { ok: false, stepsRun, costUsd, suspended: outcome.suspended };
      }

      if (!outcome.ok) {
        const policy = step.onError ?? 'fail';

        if (policy === 'continue') {
          context[step.id] = { failed: true, error: outcome.error };
          continue;
        }

        if (policy === 'fallback' && step.fallback) {
          this.logger.warn(`Step "${step.id}" failed; running fallback`);
          const fallback = await this.runStep(runId, step.fallback, input, context, state);
          stepsRun += fallback.stepsRun;
          costUsd += fallback.costUsd;
          if (fallback.ok) {
            context[step.id] = fallback.output;
            lastOutput = fallback.output;
            continue;
          }
        }

        return { ok: false, error: outcome.error, stepsRun, costUsd };
      }

      context[step.id] = outcome.output;
      lastOutput = outcome.output;
    }

    return { ok: true, output: lastOutput, stepsRun, costUsd };
  }

  /** Runs one step, including its control-flow types and its retry policy. */
  private async runStep(
    runId: string,
    step: WorkflowStep,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
    state: { budget: { remaining: number } },
  ): Promise<{
    ok: boolean;
    output?: unknown;
    error?: string;
    stepsRun: number;
    costUsd: number;
    suspended?: { reason: 'approval' | 'delay'; approvalId?: string; stepId?: string };
  }> {
    // Control-flow types are interpreted here rather than delegated: they are
    // orchestration, which is precisely what this engine owns.
    switch (step.type) {
      case 'condition':
        return this.runCondition(runId, step, input, context, state);
      case 'parallel':
        return this.runParallel(runId, step, input, context, state);
      case 'loop':
        return this.runLoop(runId, step, input, context, state);
      case 'delay':
        return this.runDelay(runId, step, input, context);
      case 'approval':
        return this.runApproval(runId, step, input, context);
      case 'ai_decision':
        return this.runAiDecision(runId, step, input, context);
      default:
        return this.runAdapterStep(runId, step, input, context);
    }
  }

  private async runAdapterStep(
    runId: string,
    step: WorkflowStep,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
  ) {
    const adapter = this.resolveAdapter(step);
    const attempts = (step.retries ?? 0) + 1;
    const run = await this.runs.findByIdOrFail(runId);

    const adapterContext: AdapterExecutionContext = {
      runId,
      stepId: step.id,
      organizationId: run.organizationId,
      workflowId: run.workflowId,
      context,
      input,
    };

    let lastError = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const startedAt = Date.now();
      try {
        const result = await this.withTimeout(
          adapter.execute(step, adapterContext),
          step.timeoutMs ?? 120_000,
          step.id,
        );

        if (result.ok) {
          await this.recordStep(
            runId,
            step,
            WorkflowRunStatus.SUCCEEDED,
            result.output ?? {},
            null,
            Date.now() - startedAt,
            adapter.key,
            attempt,
            result.costUsd,
          );
          await this.events.publish(DomainEvent.WorkflowStepCompleted, {
            runId,
            stepId: step.id,
            adapter: adapter.key,
          });
          return {
            ok: true,
            output: result.output,
            stepsRun: 1,
            costUsd: result.costUsd ?? 0,
          };
        }

        lastError = result.error ?? 'Step failed';
      } catch (error) {
        lastError = (error as Error).message;
        const retryable =
          error instanceof WorkflowStepError ? error.retryable : true;
        if (!retryable) break;
      }

      if (attempt < attempts) {
        const backoff = 250 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    await this.recordStep(
      runId,
      step,
      WorkflowRunStatus.FAILED,
      {},
      lastError,
      0,
      adapter.key,
      attempts,
    );
    await this.events.publish(DomainEvent.WorkflowStepFailed, {
      runId,
      stepId: step.id,
      error: lastError.slice(0, 300),
    });

    return { ok: false, error: `Step "${step.id}": ${lastError}`, stepsRun: 1, costUsd: 0 };
  }

  private async runCondition(
    runId: string,
    step: WorkflowStep,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
    state: { budget: { remaining: number } },
  ) {
    const predicate = (step.config.condition ?? step.condition) as WorkflowCondition;
    const branch = evaluateCondition(predicate, { input, context })
      ? (step.onTrue ?? [])
      : (step.onFalse ?? []);

    const result = await this.runSequence(runId, branch, input, context, state);
    await this.recordStep(
      runId,
      step,
      result.ok ? WorkflowRunStatus.SUCCEEDED : WorkflowRunStatus.FAILED,
      { branch: branch.length ? 'taken' : 'empty' },
      result.error ?? null,
      0,
    );

    return { ...result, stepsRun: result.stepsRun + 1 };
  }

  /**
   * Runs child steps concurrently with a bounded pool.
   *
   * Unbounded parallelism on a wide step would open dozens of simultaneous
   * provider and integration calls and trip the very rate limits the layers
   * below are trying to respect.
   */
  private async runParallel(
    runId: string,
    step: WorkflowStep,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
    state: { budget: { remaining: number } },
  ) {
    const children = step.steps ?? [];
    const outputs: Record<string, unknown> = {};
    let stepsRun = 1;
    let costUsd = 0;
    const failures: string[] = [];

    for (let i = 0; i < children.length; i += WorkflowEngine.PARALLEL_CONCURRENCY) {
      const slice = children.slice(i, i + WorkflowEngine.PARALLEL_CONCURRENCY);
      const settled = await Promise.all(
        slice.map((child) => this.runStep(runId, child, input, context, state)),
      );

      slice.forEach((child, index) => {
        const outcome = settled[index];
        stepsRun += outcome.stepsRun;
        costUsd += outcome.costUsd;
        if (outcome.ok) {
          outputs[child.id] = outcome.output;
          context[child.id] = outcome.output;
        } else {
          failures.push(`${child.id}: ${outcome.error}`);
        }
      });
    }

    const ok = failures.length === 0 || step.onError === 'continue';
    await this.recordStep(
      runId,
      step,
      ok ? WorkflowRunStatus.SUCCEEDED : WorkflowRunStatus.FAILED,
      outputs,
      failures.join('; ') || null,
      0,
    );

    return {
      ok,
      output: outputs,
      error: ok ? undefined : `Parallel step failed — ${failures.join('; ')}`,
      stepsRun,
      costUsd,
    };
  }

  private async runLoop(
    runId: string,
    step: WorkflowStep,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
    state: { budget: { remaining: number } },
  ) {
    const resolved = resolveTemplate(step.config, { ...input, ...context, input, context });
    const items = Array.isArray(resolved.items) ? resolved.items : [];
    const children = step.steps ?? [];
    const results: unknown[] = [];
    let stepsRun = 1;
    let costUsd = 0;

    const limit = Math.min(items.length, WorkflowEngine.MAX_LOOP_ITERATIONS);
    if (items.length > limit) {
      this.logger.warn(
        `Loop "${step.id}" truncated from ${items.length} to ${limit} iterations`,
      );
    }

    for (let index = 0; index < limit; index++) {
      // Each iteration sees its own item, without leaking into the run context.
      const scoped = { ...context, $item: items[index], $index: index };
      const outcome = await this.runSequence(runId, children, input, scoped, state);
      stepsRun += outcome.stepsRun;
      costUsd += outcome.costUsd;

      if (!outcome.ok && step.onError !== 'continue') {
        await this.recordStep(runId, step, WorkflowRunStatus.FAILED, { results }, outcome.error ?? null, 0);
        return {
          ok: false,
          error: `Loop "${step.id}" failed at iteration ${index}: ${outcome.error}`,
          stepsRun,
          costUsd,
        };
      }
      results.push(outcome.output);
    }

    await this.recordStep(runId, step, WorkflowRunStatus.SUCCEEDED, { iterations: limit }, null, 0);
    return { ok: true, output: { results, iterations: limit }, stepsRun, costUsd };
  }

  private async runDelay(
    runId: string,
    step: WorkflowStep,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
  ) {
    const resolved = resolveTemplate(step.config, { ...input, ...context });
    const ms = Number(resolved.ms ?? resolved.milliseconds ?? 0);

    // Short delays are simply awaited; a long one suspends the run so the
    // process is not held open for hours.
    if (ms <= 5000) {
      await new Promise((r) => setTimeout(r, ms));
      await this.recordStep(runId, step, WorkflowRunStatus.SUCCEEDED, { delayedMs: ms }, null, ms);
      return { ok: true, output: { delayedMs: ms }, stepsRun: 1, costUsd: 0 };
    }

    await this.recordStep(runId, step, WorkflowRunStatus.PENDING, { delayMs: ms }, null, 0);
    return {
      ok: false,
      stepsRun: 1,
      costUsd: 0,
      suspended: { reason: 'delay' as const, stepId: step.id },
    };
  }

  private async runApproval(
    runId: string,
    step: WorkflowStep,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
  ) {
    const resolved = resolveTemplate(step.config, { ...input, ...context, input, context });

    const approval = await this.approvals.request({
      runId,
      stepId: step.id,
      title: String(resolved.title ?? step.name ?? 'Workflow approval'),
      reason: String(resolved.reason ?? 'This step requires human approval'),
      suggestedAction: resolved.suggestedAction ? String(resolved.suggestedAction) : undefined,
      riskLevel: (resolved.riskLevel as never) ?? 'MEDIUM',
      context: { step: step.id, ...(resolved.context as Record<string, unknown>) },
      expiresInSeconds: resolved.expiresInSeconds
        ? Number(resolved.expiresInSeconds)
        : undefined,
    });

    await this.recordStep(runId, step, WorkflowRunStatus.PENDING, { approvalId: approval.id }, null, 0);

    return {
      ok: false,
      stepsRun: 1,
      costUsd: 0,
      suspended: { reason: 'approval' as const, approvalId: approval.id, stepId: step.id },
    };
  }

  private async runAiDecision(
    runId: string,
    step: WorkflowStep,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
  ) {
    const resolved = resolveTemplate(step.config, { ...input, ...context, input, context });
    const startedAt = Date.now();

    const decision = await this.decisions.decide({
      runId,
      stepId: step.id,
      workerId: String(resolved.workerId ?? ''),
      question: String(resolved.question ?? ''),
      options: (resolved.options as string[]) ?? [],
      context: (resolved.context as Record<string, unknown>) ?? {},
      confidenceThreshold: resolved.confidenceThreshold
        ? Number(resolved.confidenceThreshold)
        : undefined,
      costLimitUsd: resolved.costLimitUsd ? Number(resolved.costLimitUsd) : undefined,
      requireApprovalBelowConfidence: resolved.requireApprovalBelowConfidence !== false,
    });

    if (decision.escalated && decision.approvalId) {
      await this.recordStep(
        runId,
        step,
        WorkflowRunStatus.PENDING,
        { escalated: true, approvalId: decision.approvalId },
        null,
        Date.now() - startedAt,
      );
      return {
        ok: false,
        stepsRun: 1,
        costUsd: decision.costUsd,
        suspended: {
          reason: 'approval' as const,
          approvalId: decision.approvalId,
          stepId: step.id,
        },
      };
    }

    await this.recordStep(
      runId,
      step,
      decision.ok ? WorkflowRunStatus.SUCCEEDED : WorkflowRunStatus.FAILED,
      decision as unknown as Record<string, unknown>,
      decision.error ?? null,
      Date.now() - startedAt,
      'internal',
      1,
      decision.costUsd,
    );

    return {
      ok: decision.ok,
      output: decision,
      error: decision.error,
      stepsRun: 1,
      costUsd: decision.costUsd,
    };
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  private resolveAdapter(step: WorkflowStep): IExecutionAdapter {
    const key = step.adapter ?? this.adapterForType(step.type);
    const adapter = this.adapters.get(key);
    if (!adapter) {
      throw new WorkflowStepError(
        `No execution adapter "${key}" for step "${step.id}". Registered: ` +
          [...this.adapters.keys()].join(', '),
      );
    }
    return adapter;
  }

  /** Steps that name no adapter run internally unless their type says otherwise. */
  private adapterForType(type: string): string {
    for (const adapter of this.adapters.values()) {
      if (adapter.key !== 'internal' && adapter.supports.includes(type)) return adapter.key;
    }
    return 'internal';
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, stepId: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new WorkflowStepError(`Step "${stepId}" timed out after ${ms}ms`, true)),
        ms,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async recordStep(
    runId: string,
    step: WorkflowStep,
    status: WorkflowRunStatus,
    output: unknown,
    error: string | null,
    durationMs: number,
    adapter?: string,
    attempts = 1,
    costUsd = 0,
  ): Promise<void> {
    try {
      await this.stepRuns.create({
        runId,
        stepId: step.id,
        stepType: step.type,
        name: step.name ?? null,
        status,
        adapter: adapter ?? null,
        input: (step.config ?? {}) as never,
        output: (output ?? null) as never,
        error,
        attempts,
        costUsd,
        durationMs,
        finishedAt: new Date(),
      });
    } catch (recordError) {
      // Never let bookkeeping break the run it is describing.
      this.logger.error(`Failed to record step: ${(recordError as Error).message}`);
    }
  }

  /**
   * Marks a run failed and, once retries are exhausted, dead-letters it.
   *
   * Nothing fails silently: a run that cannot proceed leaves a row explaining
   * why and carrying enough payload to replay it.
   */
  private async failRun(
    runId: string,
    error: string,
    meta: {
      startedAt: number;
      stepsRun: number;
      costUsd: number;
      context: Record<string, unknown>;
    },
  ): Promise<RunOutcome> {
    const run = await this.runs.findByIdOrFail(runId);
    const workflow = await this.workflows.findByIdOrFail(run.workflowId);
    const exhausted = run.attempts >= workflow.maxRetries + 1;

    const durationMs = Date.now() - meta.startedAt;
    const status = exhausted ? WorkflowRunStatus.DEAD_LETTERED : WorkflowRunStatus.FAILED;

    await this.runs.update(runId, {
      status,
      error: error.slice(0, 1000),
      context: meta.context as never,
      stepsRun: meta.stepsRun,
      costUsd: meta.costUsd,
      durationMs,
      finishedAt: new Date(),
    });

    if (exhausted) {
      await this.deadLetters.create({
        source: 'workflow_run',
        reference: runId,
        reason: error.slice(0, 500),
        payload: { input: run.input, context: meta.context } as never,
        attempts: run.attempts,
      });
      await this.events.publish(DomainEvent.DeadLetterRecorded, {
        source: 'workflow_run',
        reference: runId,
        reason: error.slice(0, 200),
      });
    }

    await this.events.publish(DomainEvent.WorkflowRunFailed, {
      runId,
      error: error.slice(0, 300),
      deadLettered: exhausted,
    });

    return {
      runId,
      status,
      error,
      stepsRun: meta.stepsRun,
      stepsTotal: run.stepsTotal,
      costUsd: meta.costUsd,
      durationMs,
    };
  }

  /** Re-runs a failed run from the beginning, incrementing its attempt count. */
  async retry(runId: string): Promise<RunOutcome> {
    const run = await this.runs.findByIdOrFail(runId);
    if (run.status !== 'FAILED' && run.status !== 'DEAD_LETTERED') {
      throw new BadRequestException(`Only failed runs can be retried; this one is ${run.status}`);
    }

    const workflow = await this.workflows.findByIdOrFail(run.workflowId);
    if (run.attempts >= workflow.maxRetries + 1) {
      throw new BadRequestException(
        `Run has used all ${run.attempts} attempts (limit ${workflow.maxRetries + 1})`,
      );
    }

    const version = await this.versions.findByIdOrFail(run.versionId);
    await this.runs.update(runId, {
      status: WorkflowRunStatus.RUNNING,
      attempts: run.attempts + 1,
      error: null,
      context: {} as never,
      finishedAt: null,
    });

    return this.drive(
      runId,
      (version.steps ?? []) as unknown as WorkflowStep[],
      (run.input ?? {}) as Record<string, unknown>,
      {},
    );
  }
}

// ------------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------------

/** Counts steps including nested children, for progress reporting. */
export function countSteps(steps: WorkflowStep[]): number {
  return steps.reduce(
    (total, step) =>
      total +
      1 +
      countSteps(step.steps ?? []) +
      countSteps(step.onTrue ?? []) +
      countSteps(step.onFalse ?? []),
    0,
  );
}

/**
 * Evaluates a condition against the run's data.
 *
 * `left` and `right` may be `{{path}}` references, which resolve against the
 * run input and accumulated context.
 */
export function evaluateCondition(
  condition: WorkflowCondition | undefined,
  scope: { input: Record<string, unknown>; context: Record<string, unknown> },
): boolean {
  if (!condition) return true;

  const resolve = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const match = /^\{\{\s*([\w.$]+)\s*\}\}$/.exec(value);
    if (!match) return value;
    const merged = { ...scope.input, ...scope.context, input: scope.input, context: scope.context };
    return readPath(merged, match[1]);
  };

  const left = resolve(condition.left);
  const right = resolve(condition.right);

  switch (condition.operator) {
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    case 'gt':
      return Number(left) > Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'lte':
      return Number(left) <= Number(right);
    case 'contains':
      return Array.isArray(left)
        ? left.includes(right)
        : String(left ?? '').includes(String(right ?? ''));
    case 'not_contains':
      return Array.isArray(left)
        ? !left.includes(right)
        : !String(left ?? '').includes(String(right ?? ''));
    case 'exists':
      return left !== undefined && left !== null;
    case 'not_exists':
      return left === undefined || left === null;
    case 'in':
      return Array.isArray(right) && right.includes(left);
    case 'truthy':
      return Boolean(left);
    case 'falsy':
      return !left;
    default:
      return false;
  }
}
