import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Node, NodeStatus } from '@prisma/client';
import { Observable, Subject } from 'rxjs';
import {
  NodeHeartbeatRepository,
  NodeRepository,
} from '../database/repositories/distributed.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEventEnvelope } from '../events/domain-events';
import { QueueCoordinator, QueueSnapshot, NodeQueueSnapshot } from './queue-coordinator.service';
import { MemorySyncService, SyncStatusRow } from './memory-sync.service';

export interface FleetCapacity {
  nodes: number;
  cpuCores: number;
  memoryMb: number;
  gpuCount: number;
  maxConcurrency: number;
  activeTasks: number;
  utilisation: number;
}

export interface ClusterOverview {
  generatedAt: string;
  nodesByStatus: Record<string, number>;
  nodesByType: Record<string, number>;
  nodesByRegion: Record<string, number>;
  capacity: FleetCapacity;
  health: {
    average: number;
    weakest: { slug: string; healthScore: number } | null;
    unreachable: string[];
  };
  queues: QueueSnapshot;
  perNode: NodeQueueSnapshot[];
  memory: {
    rows: SyncStatusRow[];
    maxLag: number;
    recovering: number;
  };
}

export interface NodeMetricSeries {
  nodeId: string;
  slug: string;
  points: Array<{
    at: string;
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
    gpuUsage: number;
    activeTasks: number;
    queueDepth: number;
    latencyMs: number;
    healthScore: number;
  }>;
}

/**
 * What the fleet looks like right now.
 *
 * Two shapes, because operators ask two different questions. The overview
 * answers "is anything wrong" in one payload — nothing there requires
 * knowing a node id in advance. The stream answers "what is happening", and
 * is fed from the existing event bus rather than by polling, so a dashboard
 * sees a node go offline at the moment the rest of the system does.
 *
 * Nothing here computes anything the scheduler does not already compute. A
 * monitor that derives its own health numbers is a monitor that can disagree
 * with the thing it is monitoring.
 */
@Injectable()
export class ClusterMonitorService implements OnModuleInit {
  private readonly logger = new Logger(ClusterMonitorService.name);
  private readonly stream = new Subject<DomainEventEnvelope>();

  /** Event prefixes a fleet dashboard cares about. */
  static readonly STREAMED_PREFIXES = ['node.', 'distributed.', 'cluster.', 'memory.', 'federation.'];

  constructor(
    private readonly nodes: NodeRepository,
    private readonly heartbeats: NodeHeartbeatRepository,
    private readonly queue: QueueCoordinator,
    private readonly memory: MemorySyncService,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void {
    this.events.onAny((event) => {
      if (ClusterMonitorService.STREAMED_PREFIXES.some((p) => event.name.startsWith(p))) {
        this.stream.next(event);
      }
    });
  }

  /**
   * Live fleet events.
   *
   * Filtered per subscriber by organization: the stream is process-wide, and
   * a dashboard must never see another tenant's nodes go down.
   */
  streamFor(organizationId: string): Observable<DomainEventEnvelope> {
    return new Observable((subscriber) => {
      const subscription = this.stream.subscribe((event) => {
        if (event.organizationId === organizationId) subscriber.next(event);
      });
      return () => subscription.unsubscribe();
    });
  }

  async overview(): Promise<ClusterOverview> {
    const [nodes, queues, perNode, memoryRows] = await Promise.all([
      this.nodes.findMany({}, { orderBy: { slug: 'asc' } }),
      this.queue.snapshot(),
      this.queue.perNode(),
      this.memory.status(),
    ]);

    const capacity = ClusterMonitorService.capacityOf(nodes);
    const live = nodes.filter(
      (n) => n.status === NodeStatus.ONLINE || n.status === NodeStatus.DEGRADED,
    );

    const average =
      live.length > 0
        ? Number((live.reduce((sum, n) => sum + n.healthScore, 0) / live.length).toFixed(4))
        : 0;

    const weakest = live.reduce<Node | null>(
      (worst, node) => (!worst || node.healthScore < worst.healthScore ? node : worst),
      null,
    );

    return {
      generatedAt: new Date().toISOString(),
      nodesByStatus: ClusterMonitorService.tally(nodes, (n) => n.status),
      nodesByType: ClusterMonitorService.tally(nodes, (n) => n.type),
      nodesByRegion: ClusterMonitorService.tally(nodes, (n) => n.region),
      capacity,
      health: {
        average,
        weakest: weakest ? { slug: weakest.slug, healthScore: weakest.healthScore } : null,
        unreachable: nodes
          .filter((n) => n.status === NodeStatus.OFFLINE || n.status === NodeStatus.QUARANTINED)
          .map((n) => n.slug),
      },
      queues,
      perNode,
      memory: {
        rows: memoryRows,
        maxLag: memoryRows.reduce((max, row) => Math.max(max, row.lag), 0),
        recovering: memoryRows.filter((row) => row.recovering).length,
      },
    };
  }

  async metrics(nodeId: string, take = 60): Promise<NodeMetricSeries> {
    const node = await this.nodes.findByIdOrFail(nodeId);
    const rows = await this.heartbeats.recent(nodeId, take);

    return {
      nodeId,
      slug: node.slug,
      // Oldest first: a chart reads left to right, and the repository
      // returns newest first because that is what a list view wants.
      points: rows
        .slice()
        .reverse()
        .map((row) => ({
          at: row.reportedAt.toISOString(),
          cpuUsage: row.cpuUsage,
          memoryUsage: row.memoryUsage,
          diskUsage: row.diskUsage,
          gpuUsage: row.gpuUsage,
          activeTasks: row.activeTasks,
          queueDepth: row.queueDepth,
          latencyMs: row.latencyMs,
          healthScore: row.healthScore,
        })),
    };
  }

  static capacityOf(nodes: Node[]): FleetCapacity {
    // Capacity counts only nodes that could take work now. Including an
    // offline machine's cores would report headroom the fleet does not have.
    const usable = nodes.filter(
      (n) =>
        (n.status === NodeStatus.ONLINE || n.status === NodeStatus.DEGRADED) &&
        n.trust === 'TRUSTED',
    );

    const maxConcurrency = usable.reduce((sum, n) => sum + n.maxConcurrency, 0);
    const activeTasks = usable.reduce((sum, n) => sum + n.activeTasks, 0);

    return {
      nodes: usable.length,
      cpuCores: usable.reduce((sum, n) => sum + n.cpuCores, 0),
      memoryMb: usable.reduce((sum, n) => sum + n.memoryMb, 0),
      gpuCount: usable.reduce((sum, n) => sum + n.gpuCount, 0),
      maxConcurrency,
      activeTasks,
      utilisation: maxConcurrency > 0 ? Number((activeTasks / maxConcurrency).toFixed(3)) : 0,
    };
  }

  static tally<T>(rows: T[], pick: (row: T) => string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const key = pick(row);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }
}
