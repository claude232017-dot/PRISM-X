import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DistributedTask, Node, Priority } from '@prisma/client';
import {
  DistributedTaskRepository,
  NodeRepository,
} from '../database/repositories/distributed.repositories';
import { NodeRequirements } from '../nodes/node.contract';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { DistributedExecutionService } from './distributed-execution.service';
import { NodeScheduler, SchedulableNode } from './node-scheduler.service';

export interface QueueSnapshot {
  incoming: number;
  active: number;
  completed: number;
  failed: number;
  byStatus: Record<string, number>;
  oldestWaitingMs: number | null;
}

export interface NodeQueueSnapshot {
  nodeId: string;
  slug: string;
  status: string;
  activeTasks: number;
  maxConcurrency: number;
  utilisation: number;
  queued: number;
  running: number;
}

export interface RebalanceReport {
  moved: Array<{ taskId: string; from: string | null; to: string; reason: string }>;
  considered: number;
  explanation: string;
}

/**
 * Keeps the fleet's queues moving.
 *
 * Four queues — incoming, active, completed, failed — are the operator's
 * view; the coordinator's job is to make sure nothing sits in the first one
 * while capacity exists, and that nothing sits in the second one after the
 * node holding it has stopped answering.
 *
 * Priority is applied at selection time rather than by keeping four separate
 * ordered structures, because a task's priority can change and its position
 * should change with it. The ordering is priority first, then age, so a
 * flood of high-priority work still drains oldest-first within its band and
 * nothing starves indefinitely at a given level.
 */
@Injectable()
export class QueueCoordinator {
  private readonly logger = new Logger(QueueCoordinator.name);

  /** Most tasks placed in a single tick, so one tenant cannot monopolise it. */
  static readonly BATCH_SIZE = 25;
  /** Utilisation above which a node is considered a rebalancing source. */
  static readonly HOT_UTILISATION = 0.8;
  /** Utilisation below which a node is considered a rebalancing target. */
  static readonly COLD_UTILISATION = 0.4;

  private static readonly PRIORITY_RANK: Record<Priority, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
  };

  constructor(
    private readonly tasks: DistributedTaskRepository,
    private readonly nodes: NodeRepository,
    private readonly execution: DistributedExecutionService,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Draining
  // ----------------------------------------------------------------

  /**
   * Places and dispatches whatever is waiting.
   *
   * Called on a timer and after anything that changes capacity — a node
   * coming online, a task completing. Returns how much it moved so a caller
   * can tick again immediately when there is clearly more to do.
   */
  async tick(limit = QueueCoordinator.BATCH_SIZE): Promise<{
    placed: number;
    deferred: number;
    tasks: DistributedTask[];
  }> {
    const waiting = QueueCoordinator.order(await this.tasks.claimable(limit * 2)).slice(0, limit);

    let placed = 0;
    let deferred = 0;
    const settled: DistributedTask[] = [];

    for (const task of waiting) {
      const outcome = await this.execution.drive(task);
      settled.push(outcome.task);
      if (outcome.task.status === 'QUEUED') deferred += 1;
      else placed += 1;
    }

    return { placed, deferred, tasks: settled };
  }

  /**
   * Priority band first, age second.
   *
   * Sorting in the application rather than the database because priority is
   * an enum whose declaration order is alphabetical, not semantic — ordering
   * by the column would put CRITICAL after HIGH.
   */
  static order(tasks: DistributedTask[]): DistributedTask[] {
    return [...tasks].sort((a, b) => {
      const rank =
        QueueCoordinator.PRIORITY_RANK[a.priority] - QueueCoordinator.PRIORITY_RANK[b.priority];
      if (rank !== 0) return rank;
      return a.queuedAt.getTime() - b.queuedAt.getTime();
    });
  }

  // ----------------------------------------------------------------
  // Migration and rebalancing
  // ----------------------------------------------------------------

  /**
   * Moves a task to another node.
   *
   * Migration keeps the task's identity, increments a visible counter and
   * records where it came from. A task that has bounced four times is a
   * signal about the work, not the fleet, and the counter is how that
   * becomes noticeable instead of invisible.
   */
  async migrate(
    taskId: string,
    options: { toNodeId?: string; reason?: string } = {},
  ): Promise<DistributedTask> {
    const task = await this.tasks.findByIdOrFail(taskId);

    if (task.status === 'SUCCEEDED') {
      throw new BadRequestException('A completed task cannot be migrated');
    }

    const from = task.nodeId;
    if (from) {
      // The old node loses the reservation immediately; if it is merely slow
      // rather than dead its result will be refused by the lease check.
      await this.nodes.adjustLoad(from, -1);
    }

    const migrating = await this.tasks.update(taskId, {
      status: 'MIGRATING',
      previousNodeId: from,
      nodeId: null,
      migrations: task.migrations + 1,
      leaseExpiresAt: null,
    });

    const requeued = await this.tasks.update(taskId, {
      queue: 'INCOMING',
      status: 'QUEUED',
      availableAt: new Date(),
      requirements: (options.toNodeId
        ? { ...((task.requirements ?? {}) as Record<string, unknown>), nodeId: options.toNodeId }
        : ((task.requirements ?? {}) as Record<string, unknown>)) as never,
    });

    await this.events.publish(DomainEvent.DistributedTaskMigrated, {
      distributedTaskId: taskId,
      from,
      to: options.toNodeId ?? null,
      migrations: migrating.migrations,
      reason: options.reason ?? 'operator request',
    });

    return requeued;
  }

  /**
   * Shifts queued work off saturated nodes onto idle ones.
   *
   * Only *queued* tasks move. Interrupting work that is already running to
   * even out a graph costs more than the imbalance does, and the numbers
   * that would justify it are exactly the numbers that are least reliable —
   * a node reports its own load.
   */
  async rebalance(): Promise<RebalanceReport> {
    const pool = (await this.nodes.schedulable()) as SchedulableNode[];
    const moved: RebalanceReport['moved'] = [];

    const utilisation = (node: Node) =>
      node.maxConcurrency > 0 ? node.activeTasks / node.maxConcurrency : 1;

    const hot = pool.filter((n) => utilisation(n) >= QueueCoordinator.HOT_UTILISATION);
    const cold = pool.filter((n) => utilisation(n) <= QueueCoordinator.COLD_UTILISATION);

    if (hot.length === 0 || cold.length === 0) {
      return {
        moved,
        considered: pool.length,
        explanation:
          hot.length === 0
            ? 'No node is hot enough to warrant moving work.'
            : 'No node is idle enough to receive work.',
      };
    }

    let considered = 0;
    for (const node of hot) {
      const pinned = await this.tasks.listForNode(node.id, ['ASSIGNED']);
      for (const task of pinned) {
        considered += 1;
        const target = cold.find((c) => c.activeTasks < c.maxConcurrency);
        if (!target) break;

        const requirements = (task.requirements ?? {}) as NodeRequirements;
        // A pinned task stays pinned. Rebalancing must not quietly override
        // a placement someone asked for explicitly.
        if (requirements.nodeId) continue;
        if (NodeScheduler.ineligibleReason(target, requirements, []) !== null) continue;

        await this.migrate(task.id, { toNodeId: target.id, reason: 'rebalance' });
        moved.push({
          taskId: task.id,
          from: node.id,
          to: target.id,
          reason: `${node.slug} at ${(utilisation(node) * 100).toFixed(0)}%`,
        });
        target.activeTasks += 1;
      }
    }

    if (moved.length > 0) {
      await this.events.publish(DomainEvent.ClusterRebalanced, {
        moved: moved.length,
        hot: hot.map((n) => n.slug),
        cold: cold.map((n) => n.slug),
      });
    }

    return {
      moved,
      considered,
      explanation:
        moved.length === 0
          ? `Considered ${considered} task(s); none were movable.`
          : `Moved ${moved.length} task(s) from ${hot.length} hot node(s).`,
    };
  }

  // ----------------------------------------------------------------
  // Observation
  // ----------------------------------------------------------------

  async snapshot(): Promise<QueueSnapshot> {
    const [incoming, active, completed, failed, byStatusRows] = await Promise.all([
      this.tasks.count({ queue: 'INCOMING' }),
      this.tasks.count({ queue: 'ACTIVE' }),
      this.tasks.count({ queue: 'COMPLETED' }),
      this.tasks.count({ queue: 'FAILED' }),
      this.tasks.countByStatus(),
    ]);

    const oldest = await this.tasks.findMany(
      { status: 'QUEUED' },
      { take: 1, orderBy: { queuedAt: 'asc' } },
    );

    const byStatus: Record<string, number> = {};
    for (const row of byStatusRows) byStatus[row.status] = row._count;

    return {
      incoming,
      active,
      completed,
      failed,
      byStatus,
      oldestWaitingMs: oldest[0] ? Date.now() - oldest[0].queuedAt.getTime() : null,
    };
  }

  async perNode(): Promise<NodeQueueSnapshot[]> {
    const nodes = await this.nodes.findMany({}, { orderBy: { slug: 'asc' } });

    return Promise.all(
      nodes.map(async (node) => {
        const [queued, running] = await Promise.all([
          this.tasks.count({ nodeId: node.id, status: 'ASSIGNED' }),
          this.tasks.count({ nodeId: node.id, status: 'RUNNING' }),
        ]);
        return {
          nodeId: node.id,
          slug: node.slug,
          status: node.status,
          activeTasks: node.activeTasks,
          maxConcurrency: node.maxConcurrency,
          utilisation:
            node.maxConcurrency > 0
              ? Number((node.activeTasks / node.maxConcurrency).toFixed(3))
              : 0,
          queued,
          running,
        };
      }),
    );
  }

  async listQueue(queue: DistributedTask['queue'], take = 50): Promise<DistributedTask[]> {
    return this.tasks.inQueue(queue, take);
  }

  /** Puts a dead-lettered or cancelled task back on the incoming queue. */
  async requeue(taskId: string): Promise<DistributedTask> {
    const task = await this.tasks.findById(taskId);
    if (!task) throw new NotFoundException(`Task "${taskId}" was not found`);
    if (task.status === 'SUCCEEDED') {
      throw new BadRequestException('That task already succeeded');
    }

    return this.tasks.update(taskId, {
      queue: 'INCOMING',
      status: 'QUEUED',
      nodeId: null,
      // The retry budget is reset deliberately: a human requeueing a
      // dead-lettered task is making a fresh decision about it, and
      // inheriting the exhausted count would fail it again immediately.
      attempts: 0,
      error: null,
      availableAt: new Date(),
      completedAt: null,
      leaseExpiresAt: null,
    });
  }
}
