import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DistributedTask, Node, Priority } from '@prisma/client';
import {
  DistributedTaskRepository,
  NodeRepository,
} from '../database/repositories/distributed.repositories';
import { NodeTransportRegistry } from '../nodes/transport/node-transports';
import { NodeService } from '../nodes/node.service';
import { NodeDispatch, NodeDispatchResult, NodeRequirements } from '../nodes/node.contract';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { NodeScheduler, Placement } from './node-scheduler.service';

export interface SubmitTaskInput {
  kind: string;
  payload?: Record<string, unknown>;
  requirements?: NodeRequirements;
  priority?: Priority;
  maxAttempts?: number;
  timeoutMs?: number;
  idempotencyKey?: string;
  workerId?: string;
  missionId?: string;
  taskId?: string;
  workflowRunId?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionOutcome {
  task: DistributedTask;
  placement?: Placement;
  dispatch?: NodeDispatchResult;
}

/**
 * Runs work somewhere in the fleet.
 *
 * The distinction this service maintains is between a *task* — which the
 * organization owns and which survives any particular machine — and an
 * *attempt* on a node, which is disposable. Callers get the task; the fleet
 * decides, and re-decides, where the attempts happen. That is what allows a
 * node to disappear mid-execution without the caller ever learning about it.
 */
@Injectable()
export class DistributedExecutionService {
  private readonly logger = new Logger(DistributedExecutionService.name);

  static readonly DEFAULT_TIMEOUT_MS = 120_000;
  /** Extra time allowed on the lease beyond the task's own timeout. */
  static readonly LEASE_GRACE_MS = 30_000;
  static readonly MAX_BACKOFF_MS = 60_000;

  constructor(
    private readonly tasks: DistributedTaskRepository,
    private readonly nodes: NodeRepository,
    private readonly nodeService: NodeService,
    private readonly scheduler: NodeScheduler,
    private readonly transports: NodeTransportRegistry,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Submission
  // ----------------------------------------------------------------

  /**
   * Enqueues work without waiting for it.
   *
   * An `idempotencyKey` makes resubmission safe: the same key returns the
   * original task instead of running the work twice. This matters more in a
   * distributed system than a single-process one, because a caller that
   * times out genuinely cannot tell whether its request was received.
   */
  async submit(input: SubmitTaskInput): Promise<DistributedTask> {
    if (!input.kind) throw new BadRequestException('A task needs a kind');

    if (input.idempotencyKey) {
      const existing = await this.tasks.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }

    const task = await this.tasks.create({
      kind: input.kind,
      payload: (input.payload ?? {}) as never,
      requirements: (input.requirements ?? {}) as never,
      priority: input.priority ?? Priority.MEDIUM,
      maxAttempts: input.maxAttempts ?? 3,
      idempotencyKey: input.idempotencyKey ?? null,
      workerId: input.workerId ?? null,
      missionId: input.missionId ?? null,
      taskId: input.taskId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      queue: 'INCOMING',
      status: 'QUEUED',
      metadata: {
        ...(input.metadata ?? {}),
        timeoutMs: input.timeoutMs ?? DistributedExecutionService.DEFAULT_TIMEOUT_MS,
      } as never,
    });

    await this.events.publish(DomainEvent.DistributedTaskQueued, {
      distributedTaskId: task.id,
      kind: task.kind,
      priority: task.priority,
    });

    return task;
  }

  /**
   * Submits and sees the work through, retrying on other nodes as needed.
   *
   * This is the synchronous face of the fleet, used where a caller genuinely
   * needs the answer — a worker execution inside a mission, say. The retry
   * loop lives here rather than in the caller so that "ran on a node that
   * died, moved, succeeded" is indistinguishable from "ran".
   */
  async run(input: SubmitTaskInput): Promise<ExecutionOutcome> {
    const task = await this.submit(input);
    return this.drive(task);
  }

  /** Places and executes a queued task, following its retry budget. */
  async drive(initial: DistributedTask): Promise<ExecutionOutcome> {
    let task = initial;
    const tried: string[] = [];
    let lastPlacement: Placement | undefined;
    let lastDispatch: NodeDispatchResult | undefined;

    while (task.attempts < task.maxAttempts) {
      const placement = await this.scheduler.place(
        (task.requirements ?? {}) as NodeRequirements,
        { exclude: tried },
      );
      lastPlacement = placement;

      if (!placement.node) {
        // Nothing can take it right now. Leave it queued rather than failing
        // it — capacity may arrive, and a task that fails for want of a node
        // would be indistinguishable from one whose work is broken.
        const updated = await this.tasks.update(task.id, {
          queue: 'INCOMING',
          status: 'QUEUED',
          error: placement.explanation,
          availableAt: new Date(Date.now() + 5_000),
        });
        return { task: updated, placement };
      }

      task = await this.assign(task, placement.node);
      tried.push(placement.node.id);

      lastDispatch = await this.dispatch(task, placement.node);
      task = await this.settle(task, placement.node, lastDispatch);

      if (task.status === 'SUCCEEDED') break;
      if (task.status === 'DEAD_LETTERED' || task.status === 'FAILED') break;
      if (lastDispatch.retryable === false) break;
    }

    return { task, placement: lastPlacement, dispatch: lastDispatch };
  }

  // ----------------------------------------------------------------
  // Assignment and dispatch
  // ----------------------------------------------------------------

  /**
   * Binds a task to a node and takes out a lease.
   *
   * The lease is the mechanism that makes node death survivable: it is a
   * deadline by which the node must report back, after which the coordinator
   * is entitled to assume the work is lost and place it elsewhere. Nothing
   * asks the node whether it is alive — silence past the deadline is answer
   * enough.
   */
  async assign(task: DistributedTask, node: Node): Promise<DistributedTask> {
    const timeoutMs = DistributedExecutionService.timeoutOf(task);
    const leaseExpiresAt = new Date(
      Date.now() + timeoutMs + DistributedExecutionService.LEASE_GRACE_MS,
    );

    const assigned = await this.tasks.update(task.id, {
      nodeId: node.id,
      originNodeId: task.originNodeId ?? node.id,
      queue: 'ACTIVE',
      status: 'ASSIGNED',
      assignedAt: new Date(),
      leaseExpiresAt,
      attempts: task.attempts + 1,
      error: null,
    });

    await this.nodes.adjustLoad(node.id, 1);

    await this.events.publish(DomainEvent.DistributedTaskAssigned, {
      distributedTaskId: task.id,
      nodeId: node.id,
      attempt: assigned.attempts,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    });

    return assigned;
  }

  /** Hands the task to whichever transport reaches the node. */
  async dispatch(task: DistributedTask, node: Node): Promise<NodeDispatchResult> {
    const transport = this.transports.resolve(node);
    const dispatch: NodeDispatch = {
      taskId: task.id,
      kind: task.kind,
      payload: (task.payload ?? {}) as Record<string, unknown>,
      organizationId: task.organizationId,
      timeoutMs: DistributedExecutionService.timeoutOf(task),
      correlationId: task.missionId ?? task.workflowRunId ?? undefined,
    };

    await this.tasks.update(task.id, { status: 'RUNNING', startedAt: new Date() });
    await this.events.publish(DomainEvent.DistributedTaskStarted, {
      distributedTaskId: task.id,
      nodeId: node.id,
      transport: transport.key,
    });

    try {
      return await transport.dispatch(node, dispatch);
    } catch (error) {
      // A transport that throws rather than returning a verdict is itself a
      // node failure — the work never got a chance, so it is retryable.
      return {
        taskId: task.id,
        status: 'FAILED',
        error: (error as Error).message,
        retryable: true,
        durationMs: 0,
        nodeId: node.id,
      };
    }
  }

  /**
   * Records the outcome of an attempt and decides what happens next.
   *
   * Three destinations: done, queued for another try, or dead-lettered. The
   * retry decision deliberately consults the *transport's* judgement about
   * whether the failure was about the node or about the work — retrying
   * malformed work on a fresh machine just wastes another machine.
   */
  async settle(
    task: DistributedTask,
    node: Node,
    result: NodeDispatchResult,
  ): Promise<DistributedTask> {
    await this.nodes.adjustLoad(node.id, -1);

    if (result.status === 'SUCCEEDED') {
      await this.nodeService.recordSuccess(node.id);
      const settled = await this.tasks.update(task.id, {
        queue: 'COMPLETED',
        status: 'SUCCEEDED',
        result: (result.result ?? {}) as never,
        completedAt: new Date(),
        durationMs: result.durationMs,
        costUsd: result.costUsd ?? 0,
        totalTokens: result.totalTokens ?? 0,
        leaseExpiresAt: null,
        error: null,
      });

      await this.events.publish(DomainEvent.DistributedTaskCompleted, {
        distributedTaskId: task.id,
        nodeId: node.id,
        durationMs: result.durationMs,
        attempts: settled.attempts,
      });
      return settled;
    }

    await this.nodeService.recordFailure(node.id);

    const exhausted = task.attempts + 1 >= task.maxAttempts;
    const unretryable = result.retryable === false;

    if (exhausted || unretryable) {
      const settled = await this.tasks.update(task.id, {
        queue: 'FAILED',
        status: unretryable ? 'FAILED' : 'DEAD_LETTERED',
        error: result.error ?? 'Task failed without a reason',
        completedAt: new Date(),
        durationMs: result.durationMs,
        leaseExpiresAt: null,
      });

      await this.events.publish(
        unretryable
          ? DomainEvent.DistributedTaskFailed
          : DomainEvent.DistributedTaskDeadLettered,
        {
          distributedTaskId: task.id,
          nodeId: node.id,
          attempts: settled.attempts,
          error: settled.error,
        },
      );
      return settled;
    }

    // Backoff doubles per attempt so a systemic problem — every node
    // rejecting the same work — does not become a hot loop across the fleet.
    const backoff = Math.min(
      DistributedExecutionService.MAX_BACKOFF_MS,
      2 ** task.attempts * 1_000,
    );

    const requeued = await this.tasks.update(task.id, {
      queue: 'INCOMING',
      status: 'QUEUED',
      nodeId: null,
      previousNodeId: node.id,
      error: result.error ?? null,
      availableAt: new Date(Date.now() + backoff),
      leaseExpiresAt: null,
    });

    await this.events.publish(DomainEvent.DistributedTaskFailed, {
      distributedTaskId: task.id,
      nodeId: node.id,
      attempts: requeued.attempts,
      willRetry: true,
      error: result.error,
    });

    return requeued;
  }

  // ----------------------------------------------------------------
  // Queries
  // ----------------------------------------------------------------

  async get(id: string): Promise<DistributedTask> {
    return this.tasks.findByIdOrFail(id);
  }

  async cancel(id: string): Promise<DistributedTask> {
    const task = await this.tasks.findByIdOrFail(id);
    if (task.status === 'SUCCEEDED') {
      throw new BadRequestException('That task has already completed');
    }

    if (task.nodeId) {
      const node = await this.nodes.findById(task.nodeId);
      if (node) {
        const transport = this.transports.resolve(node);
        await transport.cancel?.(node, task.id);
        await this.nodes.adjustLoad(node.id, -1);
      }
    }

    return this.tasks.update(id, {
      queue: 'FAILED',
      status: 'CANCELLED',
      completedAt: new Date(),
      leaseExpiresAt: null,
    });
  }

  static timeoutOf(task: DistributedTask): number {
    const metadata = (task.metadata ?? {}) as Record<string, unknown>;
    const declared = Number(metadata.timeoutMs);
    return Number.isFinite(declared) && declared > 0
      ? declared
      : DistributedExecutionService.DEFAULT_TIMEOUT_MS;
  }
}
