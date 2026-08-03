import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MemoryScope, MemoryShard, MemorySyncOp, SyncOpKind } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  MemoryShardRepository,
  MemorySyncOpRepository,
  NodeRepository,
  NodeSyncStateRepository,
} from '../database/repositories/distributed.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';

export type VectorClock = Record<string, number>;

export interface ShardWrite {
  scope: MemoryScope;
  namespace?: string;
  key: string;
  value: Record<string, unknown>;
  /** Writing node. Required for LOCAL and CACHED scopes. */
  nodeId?: string;
  tags?: string[];
  expiresAt?: Date | null;
}

export interface IncomingOp {
  scope: MemoryScope;
  namespace?: string;
  key: string;
  op: SyncOpKind;
  value?: Record<string, unknown>;
  version: number;
  nodeId: string;
  vectorClock?: VectorClock;
  /** Writer's clock, used to break a tie between concurrent writes. */
  writtenAt?: Date;
}

export interface ApplyResult {
  outcome: 'applied' | 'superseded' | 'conflict';
  shard?: MemoryShard;
  reason: string;
  /** On a conflict, which side won. */
  winner?: 'incoming' | 'existing';
}

export interface SyncPull {
  ops: MemorySyncOp[];
  cursor: number;
  latest: number;
  /** How far behind the node still is after this batch. */
  remaining: number;
}

export interface SyncStatusRow {
  nodeId: string;
  slug: string;
  scope: MemoryScope;
  lastSequence: number;
  latestSequence: number;
  lag: number;
  recovering: boolean;
  lastSyncAt: Date | null;
}

/**
 * Memory that spans machines.
 *
 * Four scopes, and the distinction between them is about *authority*, not
 * about where bytes happen to live: LOCAL belongs to one node and no one
 * else may write it, SHARED is org-wide state any node may write, CACHED is
 * a node's copy of a shared record and is always suspect, and GLOBAL is
 * control-plane state that nodes read and do not write.
 *
 * Replication is an append-only op log rather than a state broadcast. That
 * single choice gives incremental sync (read past your cursor), offline
 * tolerance (your cursor simply stops moving), conflict evidence (the losing
 * write is still in the log) and recovery (replay from where you stopped)
 * without four separate mechanisms.
 */
@Injectable()
export class MemorySyncService {
  private readonly logger = new Logger(MemorySyncService.name);

  /** Ops handed over in a single pull. */
  static readonly PULL_BATCH = 200;
  /** A cached shard older than this is refreshed from its shared original. */
  static readonly CACHE_TTL_MS = 60_000;

  constructor(
    private readonly shards: MemoryShardRepository,
    private readonly ops: MemorySyncOpRepository,
    private readonly syncStates: NodeSyncStateRepository,
    private readonly nodes: NodeRepository,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Writing
  // ----------------------------------------------------------------

  /**
   * Writes a shard and appends the op that replicates it.
   *
   * The version bump and the log entry happen together because a write that
   * is visible locally but absent from the log is precisely the state that
   * makes a fleet diverge silently.
   */
  async put(write: ShardWrite): Promise<MemoryShard> {
    const nodeId = MemorySyncService.nodeKeyFor(write.scope, write.nodeId);
    const namespace = write.namespace ?? 'default';

    const existing = await this.shards.findByKey(write.scope, namespace, write.key, nodeId);
    const version = (existing?.version ?? 0) + 1;
    const clock = MemorySyncService.tick(
      (existing?.vectorClock ?? {}) as VectorClock,
      write.nodeId ?? 'control-plane',
    );
    const checksum = MemorySyncService.checksum(write.value);

    const shard = existing
      ? await this.shards.update(existing.id, {
          value: write.value as never,
          version,
          checksum,
          vectorClock: clock as never,
          lastWriterNodeId: write.nodeId ?? null,
          tags: write.tags ?? existing.tags,
          expiresAt: write.expiresAt === undefined ? existing.expiresAt : write.expiresAt,
          deletedAt: null,
        })
      : await this.shards.create({
          scope: write.scope,
          namespace,
          key: write.key,
          nodeId,
          value: write.value as never,
          version,
          checksum,
          vectorClock: clock as never,
          ownerNodeId: write.nodeId ?? null,
          lastWriterNodeId: write.nodeId ?? null,
          tags: write.tags ?? [],
          expiresAt: write.expiresAt ?? null,
        });

    await this.appendOp({
      shardId: shard.id,
      scope: write.scope,
      namespace,
      key: write.key,
      op: SyncOpKind.PUT,
      payload: { value: write.value, checksum, vectorClock: clock },
      version,
      nodeId: write.nodeId ?? '',
      status: 'APPLIED',
    });

    await this.events.publish(DomainEvent.MemoryShardWritten, {
      shardId: shard.id,
      scope: write.scope,
      namespace,
      key: write.key,
      version,
    });

    return shard;
  }

  /**
   * Tombstones a shard.
   *
   * The row survives the delete because the delete itself has to replicate:
   * a node that never sees the tombstone would otherwise resurrect the
   * record on its next push, and the deletion would silently undo itself.
   */
  async remove(
    scope: MemoryScope,
    key: string,
    options: { namespace?: string; nodeId?: string } = {},
  ): Promise<MemoryShard | null> {
    const namespace = options.namespace ?? 'default';
    const nodeId = MemorySyncService.nodeKeyFor(scope, options.nodeId);
    const existing = await this.shards.findByKey(scope, namespace, key, nodeId);
    if (!existing) return null;

    const version = existing.version + 1;
    const shard = await this.shards.update(existing.id, {
      version,
      deletedAt: new Date(),
      lastWriterNodeId: options.nodeId ?? null,
    });

    await this.appendOp({
      shardId: shard.id,
      scope,
      namespace,
      key,
      op: SyncOpKind.DELETE,
      payload: {},
      version,
      nodeId: options.nodeId ?? '',
      status: 'APPLIED',
    });

    await this.events.publish(DomainEvent.MemoryShardDeleted, {
      shardId: shard.id,
      scope,
      namespace,
      key,
    });

    return shard;
  }

  // ----------------------------------------------------------------
  // Reading
  // ----------------------------------------------------------------

  /**
   * Reads a record, preferring a fresh node-local cache when one exists.
   *
   * A stale cache entry is skipped rather than returned with a warning,
   * because callers that must not act on old data have no way to act on a
   * warning, and callers that can tolerate it are better served by the
   * shared original anyway.
   */
  async read(
    scope: MemoryScope,
    key: string,
    options: { namespace?: string; nodeId?: string } = {},
  ): Promise<MemoryShard | null> {
    const namespace = options.namespace ?? 'default';

    if (scope === MemoryScope.SHARED && options.nodeId) {
      const cached = await this.shards.findByKey(
        MemoryScope.CACHED,
        namespace,
        key,
        options.nodeId,
      );
      if (cached && !cached.deletedAt && MemorySyncService.isFresh(cached)) return cached;
    }

    const shard = await this.shards.findByKey(
      scope,
      namespace,
      key,
      MemorySyncService.nodeKeyFor(scope, options.nodeId),
    );

    if (!shard || shard.deletedAt) return null;
    if (shard.expiresAt && shard.expiresAt < new Date()) return null;
    return shard;
  }

  /** Copies a shared record into a node's cache. */
  async cache(nodeId: string, key: string, namespace = 'default'): Promise<MemoryShard | null> {
    const source = await this.shards.findByKey(MemoryScope.SHARED, namespace, key, '');
    if (!source || source.deletedAt) return null;

    return this.put({
      scope: MemoryScope.CACHED,
      namespace,
      key,
      nodeId,
      value: source.value as Record<string, unknown>,
      tags: source.tags,
      expiresAt: new Date(Date.now() + MemorySyncService.CACHE_TTL_MS),
    });
  }

  async list(scope: MemoryScope, namespace?: string, take = 100): Promise<MemoryShard[]> {
    return this.shards.listScope(scope, namespace ? { namespace } : {}, take);
  }

  // ----------------------------------------------------------------
  // Replication
  // ----------------------------------------------------------------

  /**
   * Hands a node everything it has not seen, and advances its cursor.
   *
   * Incremental by construction: a node that has been offline for a week
   * asks the same question as one that was offline for a second, and gets a
   * proportionally larger answer rather than a different code path.
   */
  async pull(
    nodeId: string,
    scopes: MemoryScope[] = [MemoryScope.SHARED, MemoryScope.GLOBAL],
    take = MemorySyncService.PULL_BATCH,
  ): Promise<SyncPull> {
    const states = await this.syncStates.forNode(nodeId);
    const cursor = Math.min(
      ...scopes.map((scope) => states.find((s) => s.scope === scope)?.lastSequence ?? 0),
    );

    const ops = await this.ops.since(Number.isFinite(cursor) ? cursor : 0, scopes, take);
    const latest = await this.ops.latestSequence();
    const advanced = ops.length > 0 ? ops[ops.length - 1].sequence : cursor;
    const remaining = Math.max(0, latest - advanced);

    for (const scope of scopes) {
      await this.syncStates.advance(nodeId, scope, advanced, remaining, remaining > 0);
    }

    await this.events.publish(DomainEvent.MemorySyncCompleted, {
      nodeId,
      delivered: ops.length,
      cursor: advanced,
      remaining,
    });

    return { ops, cursor: advanced, latest, remaining };
  }

  /**
   * Applies a write that originated on another node.
   *
   * The rules, in order:
   *
   *  1. Nothing here yet — take it.
   *  2. The incoming clock descends from ours — a straightforward
   *     fast-forward, take it.
   *  3. Ours descends from the incoming one — the sender is behind; keep
   *     ours and mark theirs superseded. Not a conflict: no information was
   *     lost, the sender simply has not caught up.
   *  4. Neither descends from the other — a genuine concurrent write. Both
   *     sides are equally entitled, so the tie is broken deterministically
   *     (version, then time, then node id) and *both* versions stay in the
   *     log so the discarded one can be recovered by a human.
   *
   * Determinism matters more than the specific rule: every node applying the
   * same pair of writes must reach the same answer, or the fleet diverges.
   */
  async apply(incoming: IncomingOp): Promise<ApplyResult> {
    const namespace = incoming.namespace ?? 'default';
    const nodeKey = MemorySyncService.nodeKeyFor(incoming.scope, incoming.nodeId);
    const existing = await this.shards.findByKey(incoming.scope, namespace, incoming.key, nodeKey);

    const incomingClock = incoming.vectorClock ?? { [incoming.nodeId]: incoming.version };

    if (!existing) {
      if (incoming.op === SyncOpKind.DELETE) {
        return { outcome: 'applied', reason: 'delete of a record we never had' };
      }
      const shard = await this.put({
        scope: incoming.scope,
        namespace,
        key: incoming.key,
        value: incoming.value ?? {},
        nodeId: incoming.nodeId,
      });
      return { outcome: 'applied', shard, reason: 'new record' };
    }

    const existingClock = (existing.vectorClock ?? {}) as VectorClock;

    if (MemorySyncService.dominates(incomingClock, existingClock)) {
      const shard = await this.commit(existing, incoming, incomingClock);
      return { outcome: 'applied', shard, reason: 'incoming write descends from ours' };
    }

    if (MemorySyncService.dominates(existingClock, incomingClock)) {
      await this.appendOp({
        shardId: existing.id,
        scope: incoming.scope,
        namespace,
        key: incoming.key,
        op: incoming.op,
        payload: { value: incoming.value ?? {}, vectorClock: incomingClock },
        version: incoming.version,
        nodeId: incoming.nodeId,
        status: 'SUPERSEDED',
        resolution: `local version ${existing.version} already includes this write`,
      });
      return {
        outcome: 'superseded',
        shard: existing,
        reason: `sender is behind (theirs v${incoming.version}, ours v${existing.version})`,
      };
    }

    const winner = MemorySyncService.resolveConcurrent(
      { version: incoming.version, at: incoming.writtenAt ?? new Date(), nodeId: incoming.nodeId },
      {
        version: existing.version,
        at: existing.updatedAt,
        nodeId: existing.lastWriterNodeId ?? '',
      },
    );

    const merged = MemorySyncService.merge(existingClock, incomingClock);

    const losing = await this.appendOp({
      shardId: existing.id,
      scope: incoming.scope,
      namespace,
      key: incoming.key,
      op: incoming.op,
      payload: {
        value: incoming.value ?? {},
        vectorClock: incomingClock,
        discarded: winner === 'existing',
      },
      version: incoming.version,
      nodeId: incoming.nodeId,
      status: 'CONFLICT',
      resolution:
        winner === 'incoming'
          ? `concurrent write from ${incoming.nodeId} won; previous value kept in this op log`
          : `concurrent write from ${incoming.nodeId} lost to local version ${existing.version}`,
    });

    await this.events.publish(DomainEvent.MemorySyncConflict, {
      shardId: existing.id,
      key: incoming.key,
      scope: incoming.scope,
      winner,
      opId: losing.id,
    });

    const shard =
      winner === 'incoming'
        ? await this.commit(existing, incoming, merged)
        : await this.shards.update(existing.id, { vectorClock: merged as never });

    return {
      outcome: 'conflict',
      shard,
      winner,
      reason: `concurrent writes on "${incoming.key}"; ${winner} won`,
    };
  }

  /**
   * Replays everything a node missed while it was gone.
   *
   * Recovery is not a special protocol — it is an ordinary pull that happens
   * to return a lot. Keeping it that way means the rarely-exercised path is
   * the same code as the constantly-exercised one.
   */
  async recover(nodeId: string): Promise<{ delivered: number; remaining: number }> {
    const node = await this.nodes.findByIdOrFail(nodeId);
    let delivered = 0;
    let remaining = 0;

    // Bounded rather than "until caught up": a node that has been away for
    // a month must not monopolise the log reader on its first request.
    for (let batch = 0; batch < 10; batch += 1) {
      const pull = await this.pull(nodeId);
      delivered += pull.ops.length;
      remaining = pull.remaining;
      if (pull.ops.length === 0 || remaining === 0) break;
    }

    await this.events.publish(DomainEvent.MemorySyncRecovered, {
      nodeId,
      slug: node.slug,
      delivered,
      remaining,
    });

    return { delivered, remaining };
  }

  async status(): Promise<SyncStatusRow[]> {
    const [nodes, latest] = await Promise.all([
      this.nodes.findMany({}, { orderBy: { slug: 'asc' } }),
      this.ops.latestSequence(),
    ]);

    const rows: SyncStatusRow[] = [];
    for (const node of nodes) {
      const states = await this.syncStates.forNode(node.id);
      for (const state of states) {
        rows.push({
          nodeId: node.id,
          slug: node.slug,
          scope: state.scope,
          lastSequence: state.lastSequence,
          latestSequence: latest,
          lag: Math.max(0, latest - state.lastSequence),
          recovering: state.recovering,
          lastSyncAt: state.lastSyncAt,
        });
      }
    }
    return rows;
  }

  async conflicts(take = 50): Promise<MemorySyncOp[]> {
    return this.ops.conflicts(take);
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private async commit(
    existing: MemoryShard,
    incoming: IncomingOp,
    clock: VectorClock,
  ): Promise<MemoryShard> {
    if (incoming.op === SyncOpKind.DELETE) {
      return this.shards.update(existing.id, {
        version: Math.max(existing.version, incoming.version),
        deletedAt: new Date(),
        vectorClock: clock as never,
        lastWriterNodeId: incoming.nodeId,
      });
    }

    const value = incoming.value ?? {};
    return this.shards.update(existing.id, {
      value: value as never,
      version: Math.max(existing.version, incoming.version),
      checksum: MemorySyncService.checksum(value),
      vectorClock: clock as never,
      lastWriterNodeId: incoming.nodeId,
      deletedAt: null,
    });
  }

  private appendOp(input: {
    shardId: string | null;
    scope: MemoryScope;
    namespace: string;
    key: string;
    op: SyncOpKind;
    payload: Record<string, unknown>;
    version: number;
    nodeId: string;
    status: MemorySyncOp['status'];
    resolution?: string;
  }): Promise<MemorySyncOp> {
    return this.ops.create({
      shardId: input.shardId,
      scope: input.scope,
      namespace: input.namespace,
      key: input.key,
      op: input.op,
      payload: input.payload as never,
      version: input.version,
      nodeId: input.nodeId,
      status: input.status,
      resolution: input.resolution ?? null,
      appliedAt: input.status === 'APPLIED' ? new Date() : null,
    }) as Promise<MemorySyncOp>;
  }

  // ----------------------------------------------------------------
  // Pure helpers
  // ----------------------------------------------------------------

  /** Canonical hash: keys sorted, so equal objects hash equally. */
  static checksum(value: unknown): string {
    return createHash('sha256').update(MemorySyncService.canonical(value)).digest('hex');
  }

  static canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) {
      return `[${value.map((v) => MemorySyncService.canonical(v)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${MemorySyncService.canonical(v)}`)
      .join(',')}}`;
  }

  static tick(clock: VectorClock, nodeId: string): VectorClock {
    const key = nodeId || 'control-plane';
    return { ...clock, [key]: (clock[key] ?? 0) + 1 };
  }

  static merge(a: VectorClock, b: VectorClock): VectorClock {
    const merged: VectorClock = { ...a };
    for (const [node, count] of Object.entries(b)) {
      merged[node] = Math.max(merged[node] ?? 0, count);
    }
    return merged;
  }

  /**
   * True when `a` has seen everything `b` has, and at least one thing more.
   *
   * Equal clocks do not dominate each other — that case is the same write
   * arriving twice, which needs neither an update nor a conflict.
   */
  static dominates(a: VectorClock, b: VectorClock): boolean {
    let strictlyGreater = false;
    for (const node of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const left = a[node] ?? 0;
      const right = b[node] ?? 0;
      if (left < right) return false;
      if (left > right) strictlyGreater = true;
    }
    return strictlyGreater;
  }

  static concurrent(a: VectorClock, b: VectorClock): boolean {
    return !MemorySyncService.dominates(a, b) && !MemorySyncService.dominates(b, a);
  }

  /**
   * Deterministic tie-break for two writes neither of which saw the other.
   *
   * Node id is the last resort precisely because it is arbitrary: what
   * matters at that point is not which write is better but that every node
   * picks the same one.
   */
  static resolveConcurrent(
    incoming: { version: number; at: Date; nodeId: string },
    existing: { version: number; at: Date; nodeId: string },
  ): 'incoming' | 'existing' {
    if (incoming.version !== existing.version) {
      return incoming.version > existing.version ? 'incoming' : 'existing';
    }
    const byTime = incoming.at.getTime() - existing.at.getTime();
    if (byTime !== 0) return byTime > 0 ? 'incoming' : 'existing';
    return incoming.nodeId > existing.nodeId ? 'incoming' : 'existing';
  }

  static isFresh(shard: MemoryShard, now = new Date()): boolean {
    if (shard.expiresAt) return shard.expiresAt > now;
    return now.getTime() - shard.updatedAt.getTime() < MemorySyncService.CACHE_TTL_MS;
  }

  /**
   * The `nodeId` column for a scope.
   *
   * LOCAL and CACHED records are per-node so they carry the node's id;
   * SHARED and GLOBAL records are org-wide and carry the empty-string
   * sentinel. See the schema comment on MemoryShard for why it is a sentinel
   * rather than NULL.
   */
  static nodeKeyFor(scope: MemoryScope, nodeId?: string): string {
    if (scope === MemoryScope.LOCAL || scope === MemoryScope.CACHED) {
      if (!nodeId) {
        throw new BadRequestException(`${scope} memory requires a nodeId`);
      }
      return nodeId;
    }
    return '';
  }
}
