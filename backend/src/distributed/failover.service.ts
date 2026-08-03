import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NodeStatus } from '@prisma/client';
import {
  DistributedTaskRepository,
  NodeRepository,
} from '../database/repositories/distributed.repositories';
import { NodeService } from '../nodes/node.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { QueueCoordinator } from './queue-coordinator.service';

export interface SweepReport {
  nodesMarkedOffline: string[];
  tasksReassigned: string[];
  leasesExpired: string[];
  quarantinesLifted: string[];
}

/**
 * Notices when a node has stopped being useful, and moves its work.
 *
 * The whole design rests on one asymmetry: a node can tell you it is alive,
 * but it cannot tell you it has died. So nothing here waits for bad news.
 * Two silences are watched instead — a node that stops heartbeating, and a
 * task whose lease runs out — and both are treated as loss rather than
 * delay. Occasionally that is wrong and a node was merely slow; the lease
 * check on result submission is what makes being wrong harmless.
 */
@Injectable()
export class FailoverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FailoverService.name);
  private timer?: NodeJS.Timeout;

  /** How often the sweep runs. */
  static readonly SWEEP_INTERVAL_MS = 30_000;

  constructor(
    private readonly nodes: NodeRepository,
    private readonly tasks: DistributedTaskRepository,
    private readonly nodeService: NodeService,
    private readonly queue: QueueCoordinator,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void {
    // Disabled under test so a sweep does not fire in the middle of an
    // assertion about queue state and make the suite flaky.
    if (process.env.NODE_ENV === 'test' || process.env.PRISMX_DISABLE_SWEEP === '1') return;

    this.timer = setInterval(() => {
      this.sweep().catch((error) =>
        this.logger.error(`Failover sweep failed: ${(error as Error).message}`),
      );
    }, FailoverService.SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass over the fleet.
   *
   * Runs across every tenant, which is why it works from unscoped queries
   * and re-enters a scoped context per organization rather than relying on
   * an ambient one — there is no request here and no user to attribute it to.
   */
  async sweep(): Promise<SweepReport> {
    const report: SweepReport = {
      nodesMarkedOffline: [],
      tasksReassigned: [],
      leasesExpired: [],
      quarantinesLifted: [],
    };

    const cutoff = new Date(Date.now() - NodeService.HEARTBEAT_TIMEOUT_MS);
    const stale = await this.nodes.findStaleUnscoped(cutoff);

    for (const node of stale) {
      await this.asOrganization(node.organizationId, async () => {
        await this.nodeService.markOffline(
          node.id,
          `no heartbeat since ${node.lastHeartbeatAt?.toISOString() ?? 'registration'}`,
        );
        report.nodesMarkedOffline.push(node.id);

        const orphaned = await this.tasks.findInFlightForNodeUnscoped(node.id);
        for (const task of orphaned) {
          await this.queue.migrate(task.id, { reason: `node ${node.slug} went offline` });
          report.tasksReassigned.push(task.id);
        }
      });
    }

    // A lease can expire while the node is still heartbeating — the node is
    // up, the task is stuck. Same remedy, different symptom.
    const expired = await this.tasks.findExpiredLeasesUnscoped();
    for (const task of expired) {
      if (report.tasksReassigned.includes(task.id)) continue;
      await this.asOrganization(task.organizationId, async () => {
        await this.queue.migrate(task.id, { reason: 'lease expired' });
        report.leasesExpired.push(task.id);
      });
    }

    await this.liftExpiredQuarantines(report);

    return report;
  }

  /**
   * Returns a node to service once its quarantine has elapsed.
   *
   * Quarantine is a cooling-off period, not a verdict. Without an automatic
   * release, one bad afternoon would permanently shrink the fleet and the
   * only cure would be a human noticing. The node comes back DEGRADED rather
   * than ONLINE: it is eligible again, but it starts at the back of the
   * queue and has to earn its health score back through heartbeats.
   */
  private async liftExpiredQuarantines(report: SweepReport): Promise<void> {
    const liftable = await this.nodes.findLiftableQuarantinesUnscoped();

    for (const node of liftable) {
      await this.asOrganization(node.organizationId, async () => {
        await this.nodes.update(node.id, {
          status: NodeStatus.DEGRADED,
          quarantinedUntil: null,
          consecutiveFailures: 0,
        });
        await this.events.publish(DomainEvent.NodeRecovered, {
          nodeId: node.id,
          from: 'QUARANTINED',
        });
        report.quarantinesLifted.push(node.id);
      });
    }
  }

  /**
   * Brings a node back after it has been offline.
   *
   * Called when a node that was written off starts heartbeating again. It is
   * not enough to flip the status: whatever it was holding has already been
   * placed elsewhere, so the node must come back empty rather than resume
   * work someone else is now doing.
   */
  async recoverNode(nodeId: string): Promise<{ node: string; clearedTasks: number }> {
    const node = await this.nodes.findByIdOrFail(nodeId);

    const stranded = await this.tasks.findInFlightForNodeUnscoped(nodeId);
    for (const task of stranded) {
      await this.tasks.update(task.id, {
        nodeId: null,
        queue: 'INCOMING',
        status: 'QUEUED',
        availableAt: new Date(),
        leaseExpiresAt: null,
      });
    }

    await this.nodes.update(nodeId, {
      status: NodeStatus.ONLINE,
      consecutiveFailures: 0,
      quarantinedUntil: null,
      activeTasks: 0,
    });

    await this.events.publish(DomainEvent.NodeRecovered, {
      nodeId,
      clearedTasks: stranded.length,
    });

    return { node: node.slug, clearedTasks: stranded.length };
  }

  /**
   * Guards against a resurrected node reporting a result for work that has
   * already been given to someone else.
   *
   * Without this check, a node that was presumed dead could come back and
   * overwrite a newer, correct result with its own stale one.
   */
  static holdsValidLease(
    task: { nodeId: string | null; leaseExpiresAt: Date | null },
    claimingNodeId: string,
    now = new Date(),
  ): boolean {
    if (task.nodeId !== claimingNodeId) return false;
    if (!task.leaseExpiresAt) return false;
    return task.leaseExpiresAt.getTime() > now.getTime();
  }

  private asOrganization<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return RequestContextStore.run(
      {
        userId: 'system',
        organizationId,
        roleKey: 'SYSTEM',
        permissions: ['*'],
        requestId: `failover-${Date.now()}`,
      },
      fn,
    );
  }
}
