import { BadRequestException } from '@nestjs/common';
import { MemoryScope, MemoryShard, Node, NodeStatus } from '@prisma/client';
import { MemorySyncService, VectorClock } from './memory-sync.service';
import { ClusterMonitorService } from './cluster-monitor.service';

describe('vector clocks', () => {
  const clock = (entries: VectorClock): VectorClock => entries;

  it('increments the writing node’s counter', () => {
    expect(MemorySyncService.tick({ a: 1 }, 'a')).toEqual({ a: 2 });
    expect(MemorySyncService.tick({ a: 1 }, 'b')).toEqual({ a: 1, b: 1 });
  });

  it('attributes an unattributed write to the control plane', () => {
    expect(MemorySyncService.tick({}, '')).toEqual({ 'control-plane': 1 });
  });

  it('merges by taking the highest counter seen for each node', () => {
    expect(MemorySyncService.merge({ a: 3, b: 1 }, { a: 1, c: 5 })).toEqual({ a: 3, b: 1, c: 5 });
  });

  it('recognises a clock that has seen everything and more', () => {
    expect(MemorySyncService.dominates(clock({ a: 2 }), clock({ a: 1 }))).toBe(true);
    expect(MemorySyncService.dominates(clock({ a: 1, b: 1 }), clock({ a: 1 }))).toBe(true);
  });

  it('does not let a clock dominate one it is behind on', () => {
    expect(MemorySyncService.dominates(clock({ a: 1 }), clock({ a: 2 }))).toBe(false);
    expect(MemorySyncService.dominates(clock({ a: 2, b: 1 }), clock({ a: 1, b: 2 }))).toBe(false);
  });

  it('treats identical clocks as neither dominating — the same write twice is not a conflict', () => {
    expect(MemorySyncService.dominates(clock({ a: 1 }), clock({ a: 1 }))).toBe(false);
    expect(MemorySyncService.concurrent(clock({ a: 1 }), clock({ a: 1 }))).toBe(true);
  });

  it('detects genuinely divergent writes', () => {
    expect(MemorySyncService.concurrent(clock({ a: 1 }), clock({ b: 1 }))).toBe(true);
    expect(MemorySyncService.concurrent(clock({ a: 2 }), clock({ a: 1 }))).toBe(false);
  });

  it('treats an absent node as having contributed nothing', () => {
    expect(MemorySyncService.dominates(clock({ a: 1, b: 0 }), clock({ a: 1 }))).toBe(false);
  });
});

describe('concurrent write resolution', () => {
  const at = (iso: string) => new Date(iso);

  it('prefers the higher version', () => {
    expect(
      MemorySyncService.resolveConcurrent(
        { version: 3, at: at('2026-01-01T00:00:00Z'), nodeId: 'a' },
        { version: 2, at: at('2026-01-02T00:00:00Z'), nodeId: 'b' },
      ),
    ).toBe('incoming');
  });

  it('falls back to the later write when versions match', () => {
    expect(
      MemorySyncService.resolveConcurrent(
        { version: 2, at: at('2026-01-02T00:00:00Z'), nodeId: 'a' },
        { version: 2, at: at('2026-01-01T00:00:00Z'), nodeId: 'b' },
      ),
    ).toBe('incoming');
  });

  it('falls back to node id last, so every node reaches the same answer', () => {
    const same = at('2026-01-01T00:00:00Z');
    expect(
      MemorySyncService.resolveConcurrent(
        { version: 2, at: same, nodeId: 'zeta' },
        { version: 2, at: same, nodeId: 'alpha' },
      ),
    ).toBe('incoming');
    expect(
      MemorySyncService.resolveConcurrent(
        { version: 2, at: same, nodeId: 'alpha' },
        { version: 2, at: same, nodeId: 'zeta' },
      ),
    ).toBe('existing');
  });

  it('is deterministic — the same pair always resolves the same way', () => {
    const a = { version: 2, at: at('2026-01-01T00:00:00Z'), nodeId: 'a' };
    const b = { version: 2, at: at('2026-01-01T00:00:00Z'), nodeId: 'b' };
    const first = MemorySyncService.resolveConcurrent(a, b);
    for (let i = 0; i < 20; i += 1) {
      expect(MemorySyncService.resolveConcurrent(a, b)).toBe(first);
    }
  });
});

describe('checksums', () => {
  it('hashes equal objects equally regardless of key order', () => {
    expect(MemorySyncService.checksum({ a: 1, b: 2 })).toBe(
      MemorySyncService.checksum({ b: 2, a: 1 }),
    );
  });

  it('changes when a value changes', () => {
    expect(MemorySyncService.checksum({ a: 1 })).not.toBe(MemorySyncService.checksum({ a: 2 }));
  });

  it('respects array order, which is meaningful', () => {
    expect(MemorySyncService.checksum([1, 2])).not.toBe(MemorySyncService.checksum([2, 1]));
  });

  it('canonicalises nested structures', () => {
    expect(MemorySyncService.canonical({ b: { d: 1, c: 2 }, a: [3, { f: 4, e: 5 }] })).toBe(
      '{"a":[3,{"e":5,"f":4}],"b":{"c":2,"d":1}}',
    );
  });

  it('produces a full-length sha256 digest', () => {
    expect(MemorySyncService.checksum({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('scope keys', () => {
  it('keys node-scoped memory by the node', () => {
    expect(MemorySyncService.nodeKeyFor(MemoryScope.LOCAL, 'n1')).toBe('n1');
    expect(MemorySyncService.nodeKeyFor(MemoryScope.CACHED, 'n1')).toBe('n1');
  });

  it('uses the empty-string sentinel for organization-wide memory', () => {
    expect(MemorySyncService.nodeKeyFor(MemoryScope.SHARED, 'n1')).toBe('');
    expect(MemorySyncService.nodeKeyFor(MemoryScope.GLOBAL)).toBe('');
  });

  it('refuses node-scoped memory without a node rather than silently sharing it', () => {
    expect(() => MemorySyncService.nodeKeyFor(MemoryScope.LOCAL)).toThrow(BadRequestException);
    expect(() => MemorySyncService.nodeKeyFor(MemoryScope.CACHED)).toThrow(BadRequestException);
  });
});

describe('cache freshness', () => {
  const shard = (over: Partial<MemoryShard>): MemoryShard =>
    ({ updatedAt: new Date(), expiresAt: null, ...over }) as MemoryShard;

  it('honours an explicit expiry over age', () => {
    expect(shardFresh({ expiresAt: new Date(Date.now() + 5_000), updatedAt: new Date(0) })).toBe(
      true,
    );
    expect(shardFresh({ expiresAt: new Date(Date.now() - 1) })).toBe(false);
  });

  it('falls back to the cache TTL when nothing expires it', () => {
    expect(shardFresh({ updatedAt: new Date() })).toBe(true);
    expect(
      shardFresh({ updatedAt: new Date(Date.now() - MemorySyncService.CACHE_TTL_MS - 1_000) }),
    ).toBe(false);
  });

  function shardFresh(over: Partial<MemoryShard>): boolean {
    return MemorySyncService.isFresh(shard(over));
  }
});

describe('fleet capacity', () => {
  const node = (over: Partial<Node>): Node =>
    ({
      status: NodeStatus.ONLINE,
      trust: 'TRUSTED',
      cpuCores: 8,
      memoryMb: 16384,
      gpuCount: 0,
      maxConcurrency: 4,
      activeTasks: 0,
      ...over,
    }) as Node;

  it('sums the machines that could take work now', () => {
    const capacity = ClusterMonitorService.capacityOf([
      node({ cpuCores: 8, maxConcurrency: 4 }),
      node({ cpuCores: 32, maxConcurrency: 8 }),
    ]);
    expect(capacity).toMatchObject({ nodes: 2, cpuCores: 40, maxConcurrency: 12 });
  });

  it('excludes offline and untrusted machines — their cores are not headroom', () => {
    const capacity = ClusterMonitorService.capacityOf([
      node({ cpuCores: 8 }),
      node({ cpuCores: 64, status: NodeStatus.OFFLINE }),
      node({ cpuCores: 64, trust: 'UNVERIFIED' }),
    ]);
    expect(capacity.cpuCores).toBe(8);
    expect(capacity.nodes).toBe(1);
  });

  it('counts a degraded node, which is slow rather than gone', () => {
    const capacity = ClusterMonitorService.capacityOf([node({ status: NodeStatus.DEGRADED })]);
    expect(capacity.nodes).toBe(1);
  });

  it('derives utilisation from reserved concurrency', () => {
    const capacity = ClusterMonitorService.capacityOf([
      node({ maxConcurrency: 4, activeTasks: 1 }),
      node({ maxConcurrency: 4, activeTasks: 3 }),
    ]);
    expect(capacity.utilisation).toBe(0.5);
  });

  it('reports zero utilisation rather than dividing by zero on an empty fleet', () => {
    expect(ClusterMonitorService.capacityOf([]).utilisation).toBe(0);
  });

  it('tallies rows by any dimension', () => {
    expect(
      ClusterMonitorService.tally(
        [{ status: 'ONLINE' }, { status: 'ONLINE' }, { status: 'OFFLINE' }],
        (row) => row.status,
      ),
    ).toEqual({ ONLINE: 2, OFFLINE: 1 });
  });
});
