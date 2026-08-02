import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Mission, MissionStatus, Task, TaskStatus, Worker } from '@prisma/client';
import {
  MissionRepository,
  TaskRepository,
  WorkerRepository,
} from '../../database/repositories/tenant.repositories';
import { ExecutionLogRepository } from '../../database/repositories/execution.repositories';
import { WorkerRuntimeService } from '../../workers/runtime/worker-runtime.service';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEvent } from '../../events/domain-events';

/**
 * Legal transitions for the Phase 2 lifecycle:
 *
 *   DRAFT → QUEUED → PLANNING → EXECUTING(RUNNING) → [WAITING] → COMPLETED → ARCHIVED
 *
 * Encoded as data so the whole machine is auditable in one place, and so an
 * illegal transition produces a message naming what *was* allowed rather than
 * a generic rejection.
 */
export const MISSION_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  DRAFT: ['QUEUED', 'CANCELLED'],
  QUEUED: ['PLANNING', 'RUNNING', 'CANCELLED'],
  PLANNING: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['WAITING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING: ['RUNNING', 'PAUSED', 'FAILED', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  COMPLETED: ['ARCHIVED'],
  FAILED: ['QUEUED', 'ARCHIVED'],
  CANCELLED: ['ARCHIVED'],
  ARCHIVED: [],
};

export interface MissionRunResult {
  missionId: string;
  status: MissionStatus;
  tasksExecuted: number;
  tasksSucceeded: number;
  tasksFailed: number;
  totalCostUsd: number;
  totalTokens: number;
  durationMs: number;
}

/**
 * Drives a mission from objective to outcome.
 *
 * The scheduler is a topological walk rather than a fixed order: on every
 * pass it asks which tasks have all their dependencies satisfied, runs that
 * wave, then asks again. That means the graph shape decides execution order —
 * independent branches run together, and a task never starts before the work
 * it depends on has produced output.
 *
 * Mission-level state is *derived* from task state on every pass rather than
 * tracked separately. Two sources of truth for "is this mission done" would
 * eventually disagree.
 */
@Injectable()
export class MissionOrchestrator {
  private readonly logger = new Logger(MissionOrchestrator.name);

  /** Ceiling on scheduler passes — a cycle that slipped validation cannot spin forever. */
  private static readonly MAX_WAVES = 50;
  /** Tasks run concurrently within a wave. */
  private static readonly WAVE_CONCURRENCY = 4;

  constructor(
    private readonly missions: MissionRepository,
    private readonly tasks: TaskRepository,
    private readonly workers: WorkerRepository,
    private readonly runtime: WorkerRuntimeService,
    private readonly executionLogs: ExecutionLogRepository,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  assertTransition(from: MissionStatus, to: MissionStatus): void {
    if (!MISSION_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException(
        `A ${from} mission cannot move to ${to}. Allowed: ${
          MISSION_TRANSITIONS[from].join(', ') || 'none (terminal state)'
        }`,
      );
    }
  }

  /**
   * Plans a mission: assigns a worker to every unassigned task and records
   * the resulting execution order.
   *
   * Assignment is by role and skill match, falling back to any active worker.
   * A task with no eligible worker fails planning rather than being silently
   * skipped at execution time.
   */
  async plan(missionId: string): Promise<Mission> {
    const mission = await this.missions.findByIdOrFail(missionId);

    // A DRAFT mission is queued on the way in. Requiring the caller to queue
    // it first would be a distinction without a purpose — asking to plan a
    // draft plainly means "get this ready to run".
    if (mission.status === MissionStatus.DRAFT) {
      this.assertTransition(MissionStatus.DRAFT, MissionStatus.QUEUED);
      await this.missions.update(missionId, { status: MissionStatus.QUEUED });
    } else {
      this.assertTransition(mission.status, MissionStatus.PLANNING);
    }

    await this.missions.update(missionId, { status: MissionStatus.PLANNING });

    const tasks = await this.tasks.findByMission(missionId);
    if (!tasks.length) {
      await this.missions.update(missionId, {
        status: MissionStatus.FAILED,
        waitReason: 'Mission has no tasks to plan',
      });
      throw new BadRequestException('A mission needs at least one task before planning');
    }

    const activeWorkers = await this.workers.findMany({ status: 'ACTIVE' }, { take: 100 });
    if (!activeWorkers.length) {
      await this.missions.update(missionId, {
        status: MissionStatus.FAILED,
        waitReason: 'No active workers available',
      });
      throw new BadRequestException(
        'Planning needs at least one ACTIVE worker in the organization',
      );
    }

    for (const task of tasks) {
      if (task.workerId) continue;
      const worker = MissionOrchestrator.selectWorker(task, activeWorkers);
      await this.tasks.update(task.id, { workerId: worker.id });
    }

    const refreshed = await this.tasks.findByMission(missionId);
    const waves = MissionOrchestrator.computeWaves(refreshed);

    const plan = {
      generatedAt: new Date().toISOString(),
      waves: waves.map((wave, i) => ({
        wave: i + 1,
        tasks: wave.map((t) => ({ id: t.id, title: t.title, workerId: t.workerId })),
      })),
      totalTasks: refreshed.length,
    };

    const updated = await this.missions.update(missionId, { plan: plan as never });

    await this.events.publish(DomainEvent.MissionPlanned, {
      missionId,
      waves: waves.length,
      totalTasks: refreshed.length,
    });

    return updated;
  }

  /**
   * Runs a mission to completion (or to the first blocking condition).
   *
   * Plans first if that has not happened, then walks the graph wave by wave.
   */
  async run(missionId: string): Promise<MissionRunResult> {
    const startedAt = Date.now();
    let mission = await this.missions.findByIdOrFail(missionId);

    if (mission.status === MissionStatus.QUEUED || mission.status === MissionStatus.DRAFT) {
      if (mission.status === MissionStatus.DRAFT) {
        await this.missions.update(missionId, { status: MissionStatus.QUEUED });
      }
      mission = await this.plan(missionId);
    }

    if (mission.status === MissionStatus.PLANNING) {
      this.assertTransition(MissionStatus.PLANNING, MissionStatus.RUNNING);
      mission = await this.missions.update(missionId, {
        status: MissionStatus.RUNNING,
        startedAt: mission.startedAt ?? new Date(),
      });
      await this.events.publish(DomainEvent.MissionStarted, {
        missionId,
        title: mission.title,
      });
    } else if (
      mission.status === MissionStatus.WAITING ||
      mission.status === MissionStatus.PAUSED
    ) {
      mission = await this.missions.update(missionId, {
        status: MissionStatus.RUNNING,
        waitReason: null,
      });
      await this.events.publish(DomainEvent.MissionResumed, { missionId });
    } else if (mission.status !== MissionStatus.RUNNING) {
      throw new BadRequestException(
        `Mission is ${mission.status} and cannot be executed`,
      );
    }

    let executed = 0;
    let succeeded = 0;
    let failed = 0;

    for (let wave = 0; wave < MissionOrchestrator.MAX_WAVES; wave++) {
      const current = await this.missions.findByIdOrFail(missionId);

      // Honour a cancellation or pause that arrived mid-run.
      if (
        current.status === MissionStatus.CANCELLED ||
        current.status === MissionStatus.PAUSED
      ) {
        this.logger.log(`Mission ${missionId} halted mid-run (${current.status})`);
        break;
      }

      const runnable = await this.tasks.findRunnable(missionId);
      if (!runnable.length) break;

      const results = await this.executeWave(runnable, missionId);
      executed += results.length;
      succeeded += results.filter((r) => r.ok).length;
      failed += results.filter((r) => !r.ok).length;

      await this.reconcile(missionId);
    }

    const finalState = await this.reconcile(missionId);
    const totals = await this.executionLogs.summarize({ missionId });

    await this.missions.update(missionId, {
      totalCostUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
    });

    return {
      missionId,
      status: finalState.status,
      tasksExecuted: executed,
      tasksSucceeded: succeeded,
      tasksFailed: failed,
      totalCostUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Executes one wave with bounded concurrency.
   *
   * The bound matters: an unbounded wave on a wide graph would open dozens of
   * simultaneous provider calls and trip rate limits that the Provider
   * Manager would then have to absorb.
   */
  private async executeWave(
    tasks: Task[],
    missionId: string,
  ): Promise<{ taskId: string; ok: boolean }[]> {
    const results: { taskId: string; ok: boolean }[] = [];

    for (let i = 0; i < tasks.length; i += MissionOrchestrator.WAVE_CONCURRENCY) {
      const slice = tasks.slice(i, i + MissionOrchestrator.WAVE_CONCURRENCY);
      const settled = await Promise.all(
        slice.map((task) => this.executeTask(task, missionId)),
      );
      results.push(...settled);
    }

    return results;
  }

  private async executeTask(
    task: Task,
    missionId: string,
  ): Promise<{ taskId: string; ok: boolean }> {
    if (!task.workerId) {
      await this.tasks.update(task.id, {
        status: TaskStatus.FAILED,
        error: 'No worker assigned to this task',
        completedAt: new Date(),
      });
      return { taskId: task.id, ok: false };
    }

    await this.tasks.update(task.id, {
      status: TaskStatus.RUNNING,
      startedAt: task.startedAt ?? new Date(),
    });
    await this.events.publish(DomainEvent.TaskStarted, { missionId, taskId: task.id });

    // Upstream outputs become this task's context — this is how a DAG passes
    // work forward rather than each task starting from nothing.
    const context = await this.gatherUpstreamContext(task, missionId);

    const result = await this.runtime.execute({
      workerId: task.workerId,
      instruction: MissionOrchestrator.buildInstruction(task),
      missionId,
      taskId: task.id,
      context,
    });

    if (result.status === 'SUCCEEDED') {
      await this.tasks.update(task.id, {
        status: TaskStatus.COMPLETED,
        output: result.output.slice(0, 20_000),
        result: {
          model: result.model,
          iterations: result.iterations,
          toolCalls: result.toolCalls.length,
        } as never,
        costUsd: result.costUsd,
        tokensUsed: result.totalTokens,
        completedAt: new Date(),
      });
      await this.events.publish(DomainEvent.TaskCompleted, {
        missionId,
        taskId: task.id,
        costUsd: result.costUsd,
      });
      return { taskId: task.id, ok: true };
    }

    const attempts = task.attempts + 1;
    const canRetry = attempts <= task.maxRetries;

    await this.tasks.update(task.id, {
      // A retryable failure returns to PENDING so the next wave picks it up;
      // otherwise it is terminal and its dependents will never become runnable.
      status: canRetry ? TaskStatus.PENDING : TaskStatus.FAILED,
      attempts,
      error: result.error?.slice(0, 1000) ?? 'Execution failed',
      ...(canRetry
        ? { nextAttemptAt: new Date(Date.now() + 2 ** attempts * 1000) }
        : { completedAt: new Date() }),
    });

    await this.events.publish(
      canRetry ? DomainEvent.TaskRetried : DomainEvent.TaskFailed,
      { missionId, taskId: task.id, attempts, error: result.error?.slice(0, 300) },
    );

    return { taskId: task.id, ok: false };
  }

  /** Concatenates the outputs of a task's completed dependencies. */
  private async gatherUpstreamContext(task: Task, missionId: string): Promise<string> {
    if (!task.dependsOn.length) return '';

    const siblings = await this.tasks.findByMission(missionId);
    const upstream = siblings.filter(
      (t) => task.dependsOn.includes(t.id) && t.status === TaskStatus.COMPLETED,
    );

    if (!upstream.length) return '';

    return upstream
      .map((t) => `### ${t.title}\n${(t.output ?? '').slice(0, 4000)}`)
      .join('\n\n');
  }

  /**
   * Recomputes mission status from its tasks.
   *
   * Four outcomes: everything finished → COMPLETED; nothing can proceed
   * because of failures → FAILED; nothing runnable but retries are pending →
   * WAITING; otherwise still RUNNING.
   */
  private async reconcile(missionId: string): Promise<Mission> {
    const mission = await this.missions.findByIdOrFail(missionId);
    const tasks = await this.tasks.findByMission(missionId);

    if (!tasks.length) return mission;
    if (
      mission.status === MissionStatus.CANCELLED ||
      mission.status === MissionStatus.PAUSED ||
      mission.status === MissionStatus.ARCHIVED
    ) {
      return mission;
    }

    const done = tasks.filter(
      (t) => t.status === TaskStatus.COMPLETED || t.status === TaskStatus.SKIPPED,
    );
    const failed = tasks.filter((t) => t.status === TaskStatus.FAILED);
    const pending = tasks.filter(
      (t) => t.status === TaskStatus.PENDING || t.status === TaskStatus.QUEUED,
    );
    const progress = Math.round((done.length / tasks.length) * 100);

    if (done.length === tasks.length) {
      const completed = await this.missions.update(missionId, {
        status: MissionStatus.COMPLETED,
        progress: 100,
        completedAt: new Date(),
        waitReason: null,
      });
      await this.events.publish(DomainEvent.MissionCompleted, {
        missionId,
        tasks: tasks.length,
      });
      return completed;
    }

    if (failed.length && done.length + failed.length === tasks.length) {
      const failedMission = await this.missions.update(missionId, {
        status: MissionStatus.FAILED,
        progress,
        completedAt: new Date(),
        waitReason: `${failed.length} task(s) failed and no further work is runnable`,
      });
      await this.events.publish(DomainEvent.MissionFailed, {
        missionId,
        failedTasks: failed.length,
      });
      return failedMission;
    }

    // Work remains, but none of it is currently runnable — every pending task
    // is blocked behind a dependency that has not completed.
    const runnable = await this.tasks.findRunnable(missionId);
    if (!runnable.length && pending.length) {
      const waiting = await this.missions.update(missionId, {
        status: MissionStatus.WAITING,
        progress,
        waitReason: `${pending.length} task(s) blocked on unmet dependencies`,
      });
      await this.events.publish(DomainEvent.MissionWaiting, {
        missionId,
        blockedTasks: pending.length,
      });
      return waiting;
    }

    return this.missions.update(missionId, { progress });
  }

  // ----------------------------------------------------------------
  // Control operations
  // ----------------------------------------------------------------

  async cancel(missionId: string): Promise<Mission> {
    const mission = await this.missions.findByIdOrFail(missionId);
    this.assertTransition(mission.status, MissionStatus.CANCELLED);

    const cancelled = await this.missions.update(missionId, {
      status: MissionStatus.CANCELLED,
      completedAt: new Date(),
    });

    // Tasks that never started are skipped rather than left dangling as
    // PENDING, which would make a cancelled mission look resumable.
    const tasks = await this.tasks.findByMission(missionId);
    for (const task of tasks.filter((t) => t.status === TaskStatus.PENDING)) {
      await this.tasks.update(task.id, { status: TaskStatus.SKIPPED });
    }

    await this.events.publish(DomainEvent.MissionCancelled, { missionId });
    return cancelled;
  }

  /** Re-queues a failed mission and resets its failed tasks for another attempt. */
  async retry(missionId: string): Promise<Mission> {
    const mission = await this.missions.findByIdOrFail(missionId);
    this.assertTransition(mission.status, MissionStatus.QUEUED);

    if (mission.retryCount >= mission.maxRetries) {
      throw new BadRequestException(
        `Mission has already been retried ${mission.retryCount} time(s), ` +
          `its limit is ${mission.maxRetries}`,
      );
    }

    const tasks = await this.tasks.findByMission(missionId);
    for (const task of tasks.filter((t) => t.status === TaskStatus.FAILED)) {
      await this.tasks.update(task.id, {
        status: TaskStatus.PENDING,
        // Attempts reset with the mission-level retry: this is a fresh run,
        // not a continuation of the previous task-level backoff.
        attempts: 0,
        error: null,
        completedAt: null,
        nextAttemptAt: null,
      });
    }

    const requeued = await this.missions.update(missionId, {
      status: MissionStatus.QUEUED,
      retryCount: mission.retryCount + 1,
      completedAt: null,
      waitReason: null,
    });

    await this.events.publish(DomainEvent.MissionRetried, {
      missionId,
      attempt: mission.retryCount + 1,
    });
    return requeued;
  }

  /** Resumes a paused or waiting mission. */
  async resume(missionId: string): Promise<MissionRunResult> {
    const mission = await this.missions.findByIdOrFail(missionId);
    if (
      mission.status !== MissionStatus.PAUSED &&
      mission.status !== MissionStatus.WAITING
    ) {
      throw new BadRequestException(
        `Only PAUSED or WAITING missions can be resumed; this one is ${mission.status}`,
      );
    }
    return this.run(missionId);
  }

  async archive(missionId: string): Promise<Mission> {
    const mission = await this.missions.findByIdOrFail(missionId);
    this.assertTransition(mission.status, MissionStatus.ARCHIVED);

    const archived = await this.missions.update(missionId, {
      status: MissionStatus.ARCHIVED,
      archivedAt: new Date(),
    });
    await this.events.publish(DomainEvent.MissionArchived, { missionId });
    return archived;
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  /**
   * Scores workers against a task and picks the best.
   *
   * Exact role match dominates, then skill overlap with the task text, then
   * fitness as a tiebreak. Deterministic, so the same graph plans the same way
   * twice.
   */
  private static selectWorker(task: Task, workers: Worker[]): Worker {
    const haystack = `${task.title} ${task.description ?? ''}`.toLowerCase();

    const scored = workers.map((worker) => {
      let score = 0;
      if (haystack.includes(worker.role.toLowerCase())) score += 10;
      score += worker.skills.filter((s) => haystack.includes(s.toLowerCase())).length * 3;
      score += worker.capabilities.filter((c) => haystack.includes(c.toLowerCase())).length * 2;
      score += worker.fitness;
      return { worker, score };
    });

    scored.sort((a, b) => b.score - a.score || a.worker.id.localeCompare(b.worker.id));
    return scored[0].worker;
  }

  /** Groups tasks into dependency waves for the recorded plan. */
  private static computeWaves(tasks: Task[]): Task[][] {
    const remaining = new Map(tasks.map((t) => [t.id, t]));
    const settled = new Set<string>();
    const waves: Task[][] = [];

    while (remaining.size) {
      const wave = [...remaining.values()].filter((t) =>
        t.dependsOn.every((d) => settled.has(d) || !remaining.has(d)),
      );

      // A cycle that escaped validation: everything left depends on something
      // still pending. Emit the remainder as one wave rather than looping.
      if (!wave.length) {
        waves.push([...remaining.values()]);
        break;
      }

      waves.push(wave);
      for (const task of wave) {
        settled.add(task.id);
        remaining.delete(task.id);
      }
    }

    return waves;
  }

  private static buildInstruction(task: Task): string {
    return task.description
      ? `${task.title}\n\n${task.description}`
      : task.title;
  }
}
