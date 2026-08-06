import { Injectable } from '@nestjs/common';
import type {
  DistributedTask,
  FederationGrant,
  MemoryShard,
  MemorySyncOp,
  Node,
  NodeCapability,
  NodeHeartbeat,
  NodeKey,
  NodeSyncState,
} from '@prisma/client';
import { BaseRepository } from './base.repository';
import { PrismaService } from '../prisma.service';
import { Unscoped } from '../tenancy';

/**
 * Phase 4 repositories.
 *
 * Each declares a constructor that only calls super() — TypeScript emits the
 * `design:paramtypes` metadata Nest needs for injection only when a class
 * declares one.
 *
 * A few methods here are deliberately *unscoped* and say so in their names.
 * The coordinator and the node agent both run outside any user request: a
 * heartbeat arrives authenticated by a node signature rather than a JWT, and
 * the sweep that reclaims expired leases has to look across tenants. Those
 * paths resolve the organization from the row they found and then re-enter a
 * scoped context, so the isolation boundary moves rather than disappearing.
 */

@Injectable()
export class NodeRepository extends BaseRepository<Node> {
  protected readonly modelName = 'node';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findBySlug(slug: string): Promise<Node | null> {
    return this.delegate().findFirst({ where: this.scope({ slug }) });
  }

  findLocal(): Promise<Node | null> {
    return this.delegate().findFirst({ where: this.scope({ isLocal: true }) });
  }

  /**
   * Every node the scheduler should look at, including ones it will reject.
   *
   * Deliberately not filtered down to "eligible" here. Eligibility is the
   * scheduler's decision and it reports a reason for each exclusion; a node
   * removed by a SQL predicate would vanish from that report, so an operator
   * asking why their machine is idle would be told nothing at all. Only
   * genuinely gone nodes are excluded.
   */
  candidates(): Promise<Node[]> {
    return this.findMany(
      { status: { not: 'DECOMMISSIONED' } },
      { orderBy: { healthScore: 'desc' }, include: { capabilities: true } },
    );
  }

  /** Nodes actually able to take work, for load accounting and rebalancing. */
  schedulable(): Promise<Node[]> {
    return this.findMany(
      {
        status: { in: ['ONLINE', 'DEGRADED'] },
        trust: 'TRUSTED',
        allowRemoteExecution: true,
        OR: [{ quarantinedUntil: null }, { quarantinedUntil: { lt: new Date() } }],
      },
      { orderBy: { healthScore: 'desc' }, include: { capabilities: true } },
    );
  }

  withCapabilities(id: string): Promise<Node | null> {
    return this.findById(id, { include: { capabilities: true } });
  }

  /**
   * Node lookup by id without tenant scope, for the agent API where the
   * caller proves identity with a node signature instead of a session. The
   * organization is read off the row and used to scope everything after.
   */
  findByIdUnscoped(id: string): Promise<Node | null> {
    return this.prisma.node.findFirst({ where: { id, deletedAt: null } });
  }

  /**
   * Nodes whose last heartbeat predates the cutoff, across all tenants — the
   * liveness sweep has no ambient organization to work from.
   */
  findStaleUnscoped(cutoff: Date): Promise<Node[]> {
    return this.prisma.node.findMany({
      where: {
        deletedAt: null,
        status: { in: ['ONLINE', 'DEGRADED'] },
        lastHeartbeatAt: { lt: cutoff },
      },
    });
  }

  /**
   * Schedulable nodes belonging to a *different* organization.
   *
   * Only reachable through FederationService, which refuses unless an active
   * grant names `nodes:execute`. The unscoped query is the mechanism; the
   * grant check is the authorisation, and one is useless without the other.
   */
  findSchedulableForOrganizationUnscoped(organizationId: string): Promise<Node[]> {
    return this.prisma.node.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { in: ['ONLINE', 'DEGRADED'] },
        trust: 'TRUSTED',
        allowRemoteExecution: true,
      },
      include: { capabilities: true },
      orderBy: { healthScore: 'desc' },
    });
  }

  /**
   * Quarantined nodes whose cooling-off period has elapsed. Unscoped for the
   * same reason as the liveness sweep.
   */
  findLiftableQuarantinesUnscoped(now = new Date()): Promise<Node[]> {
    return this.prisma.node.findMany({
      where: {
        deletedAt: null,
        status: 'QUARANTINED',
        quarantinedUntil: { lt: now },
      },
    });
  }

  /**
   * Concurrency accounting for a node, applied as a relative delta inside the
   * database rather than a read-modify-write, so two dispatches landing at
   * once cannot both read the same "before" value and lose one increment.
   */
  async adjustLoad(id: string, delta: number): Promise<void> {
    await this.prisma.node.updateMany({
      where: { id, organizationId: this.organizationId },
      data: { activeTasks: { increment: delta } },
    });
  }
}

@Injectable()
export class NodeCapabilityRepository extends BaseRepository<NodeCapability> {
  protected readonly modelName = 'nodeCapability';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  listForNode(nodeId: string): Promise<NodeCapability[]> {
    return this.findMany({ nodeId }, { orderBy: { key: 'asc' } });
  }

  /**
   * Replaces a node's advertised capabilities wholesale.
   *
   * Discovery reports the full set every time, so anything absent from the
   * report is genuinely gone — a provider that was uninstalled has to stop
   * winning placements. Marking the survivors and clearing the rest in one
   * transaction avoids a window where the node looks capable of nothing.
   */
  async replaceForNode(
    nodeId: string,
    capabilities: Array<{
      kind: NodeCapability['kind'];
      key: string;
      name?: string | null;
      version?: string | null;
      detail?: Record<string, unknown>;
    }>,
  ): Promise<number> {
    const organizationId = this.organizationId;
    const seen = capabilities.map((c) => `${c.kind}:${c.key}`);

    await this.prisma.$transaction(async (tx) => {
      for (const capability of capabilities) {
        await tx.nodeCapability.upsert({
          where: {
            nodeId_kind_key: { nodeId, kind: capability.kind, key: capability.key },
          },
          create: {
            organizationId,
            nodeId,
            kind: capability.kind,
            key: capability.key,
            name: capability.name ?? null,
            version: capability.version ?? null,
            detail: (capability.detail ?? {}) as never,
            available: true,
          },
          update: {
            name: capability.name ?? null,
            version: capability.version ?? null,
            detail: (capability.detail ?? {}) as never,
            available: true,
          },
        });
      }

      const existing = await tx.nodeCapability.findMany({
        where: { nodeId, organizationId },
        select: { id: true, kind: true, key: true },
      });
      const stale = existing
        .filter((row) => !seen.includes(`${row.kind}:${row.key}`))
        .map((row) => row.id);
      if (stale.length > 0) {
        await tx.nodeCapability.deleteMany({ where: { id: { in: stale } } });
      }
    });

    return capabilities.length;
  }
}

@Injectable()
export class NodeHeartbeatRepository extends BaseRepository<NodeHeartbeat> {
  protected readonly modelName = 'nodeHeartbeat';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  recent(nodeId: string, take = 50): Promise<NodeHeartbeat[]> {
    return this.findMany({ nodeId }, { take, orderBy: { reportedAt: 'desc' } });
  }
}

@Injectable()
export class NodeKeyRepository extends BaseRepository<NodeKey> {
  protected readonly modelName = 'nodeKey';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Every key that could still verify a signature: the active one plus any
   * retiring key inside its overlap window. Unscoped because signature
   * verification happens before an organization is known — that is the point
   * of the signature.
   */
  verifiableUnscoped(nodeId: string): Promise<NodeKey[]> {
    return this.prisma.nodeKey.findMany({
      where: {
        nodeId,
        revokedAt: null,
        OR: [
          { status: 'ACTIVE' },
          { status: 'RETIRING', retiresAt: { gt: new Date() } },
        ],
      },
      orderBy: { version: 'desc' },
    });
  }

  async markUsedUnscoped(id: string): Promise<void> {
    await this.prisma.nodeKey.updateMany({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  }

  listForNode(nodeId: string): Promise<NodeKey[]> {
    return this.findMany({ nodeId }, { orderBy: { version: 'desc' } });
  }
}

@Injectable()
export class DistributedTaskRepository extends BaseRepository<DistributedTask> {
  protected readonly modelName = 'distributedTask';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findByIdempotencyKey(key: string): Promise<DistributedTask | null> {
    return this.delegate().findFirst({ where: this.scope({ idempotencyKey: key }) });
  }

  /** Tasks waiting for a placement, highest priority and oldest first. */
  claimable(take = 50): Promise<DistributedTask[]> {
    return this.findMany(
      { status: 'QUEUED', availableAt: { lte: new Date() } },
      { take, orderBy: { queuedAt: 'asc' } },
    );
  }

  listForNode(nodeId: string, statuses?: DistributedTask['status'][]) {
    return this.findMany(
      { nodeId, ...(statuses ? { status: { in: statuses } } : {}) },
      { orderBy: { queuedAt: 'asc' } },
    );
  }

  inQueue(queue: DistributedTask['queue'], take = 100): Promise<DistributedTask[]> {
    return this.findMany({ queue }, { take, orderBy: { queuedAt: 'desc' } });
  }

  /**
   * Tasks whose node stopped reporting mid-flight. Unscoped for the same
   * reason as the node sweep: the reaper is not acting for any one tenant.
   */
  findExpiredLeasesUnscoped(now = new Date()): Promise<DistributedTask[]> {
    return this.prisma.distributedTask.findMany({
      where: {
        status: { in: ['ASSIGNED', 'RUNNING'] },
        leaseExpiresAt: { lt: now },
      },
      take: 200,
    });
  }

  /** Work still owed by a node, used when it goes down or is drained. */
  findInFlightForNodeUnscoped(nodeId: string): Promise<DistributedTask[]> {
    return this.prisma.distributedTask.findMany({
      where: { nodeId, status: { in: ['ASSIGNED', 'RUNNING'] } },
    });
  }

  countByStatus(): Promise<Array<{ status: string; _count: number }>> {
    return this.prisma.distributedTask
      .groupBy({
        by: ['status'],
        where: { organizationId: this.organizationId },
        _count: { _all: true },
      })
      .then((rows) =>
        rows.map((row) => ({
          status: String(row.status),
          _count: (row._count as { _all: number })._all,
        })),
      );
  }
}

@Injectable()
export class MemoryShardRepository extends BaseRepository<MemoryShard> {
  protected readonly modelName = 'memoryShard';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Looks up one shard by its natural key. `nodeId` uses the empty-string
   * sentinel for scopes that are not node-specific — see the schema comment
   * on MemoryShard for why it is not nullable.
   */
  findByKey(
    scope: MemoryShard['scope'],
    namespace: string,
    key: string,
    nodeId = '',
  ): Promise<MemoryShard | null> {
    return this.delegate().findFirst({
      where: this.scope({ scope, namespace, key, nodeId }, { withDeleted: true }),
    });
  }

  listScope(
    scope: MemoryShard['scope'],
    where: Record<string, unknown> = {},
    take = 100,
  ): Promise<MemoryShard[]> {
    return this.findMany({ scope, ...where }, { take, orderBy: { updatedAt: 'desc' } });
  }
}

@Injectable()
export class MemorySyncOpRepository extends BaseRepository<MemorySyncOp> {
  protected readonly modelName = 'memorySyncOp';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** The incremental feed: everything a node has not seen yet. */
  since(sequence: number, scopes: MemorySyncOp['scope'][], take = 200) {
    return this.findMany(
      { sequence: { gt: sequence }, scope: { in: scopes } },
      { take, orderBy: { sequence: 'asc' } },
    );
  }

  pending(take = 200): Promise<MemorySyncOp[]> {
    return this.findMany({ status: 'PENDING' }, { take, orderBy: { sequence: 'asc' } });
  }

  conflicts(take = 100): Promise<MemorySyncOp[]> {
    return this.findMany({ status: 'CONFLICT' }, { take, orderBy: { sequence: 'desc' } });
  }

  async latestSequence(): Promise<number> {
    const row = await this.delegate().findFirst({
      where: this.scope({}),
      orderBy: { sequence: 'desc' },
    });
    return row?.sequence ?? 0;
  }
}

@Injectable()
export class NodeSyncStateRepository extends BaseRepository<NodeSyncState> {
  protected readonly modelName = 'nodeSyncState';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  forNode(nodeId: string): Promise<NodeSyncState[]> {
    return this.findMany({ nodeId });
  }

  /**
   * Cursor upsert. The natural key is (nodeId, scope), so a node coming back
   * online after a week resumes where it left off instead of replaying the
   * entire log.
   */
  async advance(
    nodeId: string,
    scope: NodeSyncState['scope'],
    lastSequence: number,
    pendingOps: number,
    recovering = false,
  ): Promise<NodeSyncState> {
    return this.prisma.nodeSyncState.upsert({
      where: { nodeId_scope: { nodeId, scope } },
      create: {
        organizationId: this.organizationId,
        nodeId,
        scope,
        lastSequence,
        pendingOps,
        recovering,
        lastSyncAt: new Date(),
      },
      update: { lastSequence, pendingOps, recovering, lastSyncAt: new Date() },
    });
  }
}

@Injectable()
export class FederationGrantRepository extends BaseRepository<FederationGrant> {
  protected readonly modelName = 'federationGrant';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** Grants this organization issued to others. */
  issued(): Promise<FederationGrant[]> {
    return this.findMany({}, { orderBy: { createdAt: 'desc' } });
  }

  /**
   * Grants other organizations issued to this one.
   *
   * `scope()` would pin `organizationId` to the current tenant, which is the
   * wrong column here — the peer is the current tenant on a received grant.
   * The predicate is written out rather than inherited so the asymmetry is
   * visible instead of implied.
   */
  received(): Promise<FederationGrant[]> {
    return this.prisma.federationGrant.findMany({
      where: { peerOrganizationId: this.organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The authorisation lookup: does `peerOrganizationId` currently hold a
   * usable grant from `organizationId`? Unscoped because it deliberately
   * spans two tenants, which is the one operation federation exists for.
   */
  async findUsableUnscoped(
    ownerOrganizationId: string,
    peerOrganizationId: string,
  ): Promise<FederationGrant | null> {
    return this.prisma.federationGrant.findFirst({
      where: {
        organizationId: ownerOrganizationId,
        peerOrganizationId,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
  }

  @Unscoped(
    'A federation grant belongs to two organizations at once. The counter is ' +
      'adjusted by whichever side is executing, and pinning it to one column ' +
      'would make the count wrong for the other.',
  )
  async adjustActive(id: string, delta: number): Promise<void> {
    await this.prisma.federationGrant.updateMany({
      where: { id },
      data: { activeTasks: { increment: delta } },
    });
  }

  /** A grant addressed *to* the caller. Used for the accept step. */
  @Unscoped(
    'The recipient of a grant is not its owner, so the row is by definition ' +
      'outside the caller\'s tenant. `peerOrganizationId` is the scope.',
  )
  findByIdUnscopedForPeer(
    id: string,
    peerOrganizationId: string,
  ): Promise<FederationGrant | null> {
    return this.prisma.federationGrant.findFirst({
      where: { id, peerOrganizationId },
    });
  }

  @Unscoped(
    'Accepting a grant is an act by the peer organization on a row owned by ' +
      'the issuer. The predicate is scoped to the accepting peer instead.',
  )
  async acceptAsPeer(id: string, peerOrganizationId: string): Promise<FederationGrant> {
    await this.prisma.federationGrant.updateMany({
      where: { id, peerOrganizationId, status: 'PENDING' },
      data: { status: 'ACTIVE', acceptedAt: new Date() },
    });
    return this.prisma.federationGrant.findFirstOrThrow({ where: { id } });
  }

  /**
   * A grant the caller is party to, on either side.
   *
   * Revocation is available to both the issuer and the recipient, so the
   * lookup cannot be pinned to one column.
   */
  findEitherSide(id: string, organizationId: string): Promise<FederationGrant | null> {
    return this.prisma.federationGrant.findFirst({
      where: {
        id,
        OR: [{ organizationId }, { peerOrganizationId: organizationId }],
      },
    });
  }

  @Unscoped(
    'Either party may revoke, so the row cannot be pinned to one side. ' +
      'Authorisation is `findEitherSide`, which the caller must pass first.',
  )
  async revokeEitherSide(id: string, revokedById: string): Promise<FederationGrant> {
    await this.prisma.federationGrant.updateMany({
      where: { id },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedById },
    });
    return this.prisma.federationGrant.findFirstOrThrow({ where: { id } });
  }
}

export const DISTRIBUTED_REPOSITORIES = [
  NodeRepository,
  NodeCapabilityRepository,
  NodeHeartbeatRepository,
  NodeKeyRepository,
  DistributedTaskRepository,
  MemoryShardRepository,
  MemorySyncOpRepository,
  NodeSyncStateRepository,
  FederationGrantRepository,
];
