import { DistributedTask, Node, NodeStatus, Priority } from '@prisma/client';
import { NodeScheduler, SchedulableNode } from './node-scheduler.service';
import { QueueCoordinator } from './queue-coordinator.service';
import { FailoverService } from './failover.service';
import { DistributedExecutionService } from './distributed-execution.service';

const node = (over: Partial<SchedulableNode> = {}): SchedulableNode =>
  ({
    id: over.id ?? 'n1',
    organizationId: 'org1',
    name: 'Node',
    slug: over.slug ?? 'node',
    type: 'CUSTOM',
    status: NodeStatus.ONLINE,
    endpointUrl: 'http://node.local',
    isLocal: false,
    region: 'default',
    version: null,
    labels: [],
    cpuCores: 8,
    cpuModel: null,
    memoryMb: 16384,
    diskMb: 0,
    gpuCount: 0,
    gpuModel: null,
    gpuMemoryMb: 0,
    maxConcurrency: 4,
    activeTasks: 0,
    queueDepth: 0,
    cpuUsage: 0,
    memoryUsage: 0,
    diskUsage: 0,
    gpuUsage: 0,
    uptimeSeconds: 0,
    latencyMs: 0,
    healthScore: 0.9,
    costPerHourUsd: 0,
    lastHeartbeatAt: new Date(),
    lastSeenIp: null,
    registeredAt: new Date(),
    trust: 'TRUSTED',
    keyVersion: 1,
    allowRemoteExecution: true,
    drainReason: null,
    consecutiveFailures: 0,
    quarantinedUntil: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    capabilities: [],
    ...over,
  }) as SchedulableNode;

type Capability = NonNullable<SchedulableNode['capabilities']>[number];

const capability = (kind: string, key: string) =>
  ({ kind, key, available: true }) as Capability;

describe('eligibility', () => {
  const reason = (over: Partial<SchedulableNode>, requirements = {}, exclude: string[] = []) =>
    NodeScheduler.ineligibleReason(node(over), requirements, exclude);

  it('accepts a healthy, trusted, idle node', () => {
    expect(reason({})).toBeNull();
  });

  it.each([
    [{ trust: 'UNVERIFIED' as const }, /trust is UNVERIFIED/],
    [{ trust: 'REVOKED' as const }, /trust is REVOKED/],
    [{ status: NodeStatus.OFFLINE }, /status is OFFLINE/],
    [{ status: NodeStatus.DRAINING }, /status is DRAINING/],
    [{ status: NodeStatus.DECOMMISSIONED }, /status is DECOMMISSIONED/],
    [{ allowRemoteExecution: false }, /execution disabled/],
    [{ deletedAt: new Date() }, /deleted/],
  ])('refuses %o', (over, pattern) => {
    expect(reason(over as Partial<SchedulableNode>)).toMatch(pattern);
  });

  it('keeps a DEGRADED node eligible — worse is not the same as unusable', () => {
    expect(reason({ status: NodeStatus.DEGRADED })).toBeNull();
  });

  it('refuses a node that is at its concurrency ceiling rather than scoring it low', () => {
    expect(reason({ activeTasks: 4, maxConcurrency: 4 })).toMatch(/at capacity/);
  });

  it('refuses a quarantined node until the hold expires', () => {
    expect(reason({ quarantinedUntil: new Date(Date.now() + 60_000) })).toBe('quarantined');
    expect(reason({ quarantinedUntil: new Date(Date.now() - 60_000) })).toBeNull();
  });

  it('honours a pin', () => {
    expect(reason({ id: 'n1' }, { nodeId: 'n2' })).toMatch(/not the pinned node/);
    expect(reason({ id: 'n1' }, { nodeId: 'n1' })).toBeNull();
  });

  it('excludes nodes the caller has already tried', () => {
    expect(reason({ id: 'n1' }, {}, ['n1'])).toMatch(/already tried/);
  });

  it('enforces hardware minimums', () => {
    expect(reason({ gpuCount: 0 }, { requiresGpu: true })).toBe('no GPU');
    expect(reason({ gpuCount: 1 }, { requiresGpu: true })).toBeNull();
    expect(reason({ cpuCores: 2 }, { minCpuCores: 4 })).toMatch(/too few cores/);
    expect(reason({ memoryMb: 1024 }, { minMemoryMb: 8192 })).toMatch(/too little memory/);
  });

  it('does not refuse a node for failing to measure its disk', () => {
    expect(reason({ diskMb: 0 }, { minDiskMb: 100_000 })).toBeNull();
    expect(reason({ diskMb: 500 }, { minDiskMb: 100_000 })).toMatch(/too little disk/);
  });

  it('requires every named label', () => {
    expect(reason({ labels: ['gpu'] }, { labels: ['gpu', 'eu'] })).toMatch(/missing label "eu"/);
    expect(reason({ labels: ['gpu', 'eu'] }, { labels: ['gpu'] })).toBeNull();
  });

  it('enforces region and cost ceilings', () => {
    expect(reason({ region: 'us' }, { region: 'eu' })).toMatch(/wrong region/);
    expect(reason({ costPerHourUsd: 4 }, { maxCostPerHourUsd: 1 })).toMatch(/too expensive/);
  });

  it('requires advertised capabilities, naming the missing one', () => {
    const gpu = { capabilities: [capability('PROVIDER', 'OLLAMA')] };
    expect(reason(gpu, { capabilities: ['PROVIDER:OPENAI'] })).toMatch(/PROVIDER:OPENAI/);
    expect(reason(gpu, { capabilities: ['PROVIDER:OLLAMA'] })).toBeNull();
  });

  it('treats a bare capability name as a provider requirement', () => {
    const gpu = { capabilities: [capability('PROVIDER', 'OLLAMA')] };
    expect(reason(gpu, { capabilities: ['ollama'] })).toBeNull();
  });

  it('ignores capabilities a node has marked unavailable', () => {
    const stale = {
      capabilities: [{ kind: 'TOOL', key: 'search', available: false }],
    } as Partial<SchedulableNode>;
    expect(reason(stale, { capabilities: ['TOOL:search'] })).toMatch(/TOOL:SEARCH/);
  });
});

describe('ranking', () => {
  it('prefers the healthier of two otherwise identical nodes', () => {
    const placement = NodeScheduler.rank([
      node({ id: 'a', slug: 'a', healthScore: 0.4 }),
      node({ id: 'b', slug: 'b', healthScore: 0.95 }),
    ]);
    expect(placement.node?.slug).toBe('b');
  });

  it('prefers the emptier node when health is equal', () => {
    const placement = NodeScheduler.rank([
      node({ id: 'a', slug: 'a', activeTasks: 3 }),
      node({ id: 'b', slug: 'b', activeTasks: 0 }),
    ]);
    expect(placement.node?.slug).toBe('b');
  });

  it('prefers the nearer node when health and load are equal', () => {
    const placement = NodeScheduler.rank([
      node({ id: 'a', slug: 'far', latencyMs: 800 }),
      node({ id: 'b', slug: 'near', latencyMs: 5 }),
    ]);
    expect(placement.node?.slug).toBe('near');
  });

  it('breaks a tie toward the cheaper node', () => {
    const placement = NodeScheduler.rank([
      node({ id: 'a', slug: 'pricey', costPerHourUsd: 8 }),
      node({ id: 'b', slug: 'cheap', costPerHourUsd: 0.05 }),
    ]);
    expect(placement.node?.slug).toBe('cheap');
  });

  it('returns no placement, with reasons, when nothing is eligible', () => {
    const placement = NodeScheduler.rank([node({ slug: 'offline', status: NodeStatus.OFFLINE })]);
    expect(placement.node).toBeNull();
    expect(placement.rejected).toHaveLength(1);
    expect(placement.explanation).toMatch(/No eligible node/);
  });

  it('says so plainly when there are no nodes at all', () => {
    expect(NodeScheduler.rank([]).explanation).toBe('No nodes are registered.');
  });

  it('reports every scoring factor, so a placement can be argued with', () => {
    const placement = NodeScheduler.rank([node()]);
    expect(placement.candidates[0].factors.map((f) => f.name)).toEqual([
      'health',
      'capacity',
      'latency',
      'hardware',
      'capability',
      'cost',
    ]);
  });

  it('weights sum to one, so a score is comparable to a probability', () => {
    const total = Object.values(NodeScheduler.WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('separates rejected nodes from merely lower-scoring ones', () => {
    const placement = NodeScheduler.rank([
      node({ id: 'a', slug: 'good' }),
      node({ id: 'b', slug: 'weak', healthScore: 0.1 }),
      node({ id: 'c', slug: 'untrusted', trust: 'UNVERIFIED' }),
    ]);
    expect(placement.candidates.map((c) => c.slug)).toEqual(['good', 'weak']);
    expect(placement.rejected.map((r) => r.slug)).toEqual(['untrusted']);
  });

  it('explains the winner by naming its strongest factors', () => {
    const placement = NodeScheduler.rank([node({ slug: 'only' })]);
    expect(placement.explanation).toMatch(/Chose only at/);
    expect(placement.explanation).toMatch(/only eligible node/);
  });
});

describe('queue ordering', () => {
  const task = (id: string, priority: Priority, queuedAt: string): DistributedTask =>
    ({ id, priority, queuedAt: new Date(queuedAt) }) as DistributedTask;

  it('drains critical work before anything else', () => {
    const ordered = QueueCoordinator.order([
      task('low', 'LOW', '2026-01-01T00:00:00Z'),
      task('critical', 'CRITICAL', '2026-01-01T05:00:00Z'),
      task('medium', 'MEDIUM', '2026-01-01T01:00:00Z'),
      task('high', 'HIGH', '2026-01-01T02:00:00Z'),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('drains oldest first within a priority band, so nothing starves', () => {
    const ordered = QueueCoordinator.order([
      task('newer', 'MEDIUM', '2026-01-02T00:00:00Z'),
      task('older', 'MEDIUM', '2026-01-01T00:00:00Z'),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(['older', 'newer']);
  });

  it('does not mutate the caller’s array', () => {
    const input = [task('a', 'LOW', '2026-01-01T00:00:00Z'), task('b', 'HIGH', '2026-01-01T00:00:00Z')];
    QueueCoordinator.order(input);
    expect(input.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('lease validity', () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);

  it('accepts a result from the node that holds a live lease', () => {
    expect(FailoverService.holdsValidLease({ nodeId: 'n1', leaseExpiresAt: future }, 'n1')).toBe(
      true,
    );
  });

  it('refuses a result from a node the task was taken away from', () => {
    expect(FailoverService.holdsValidLease({ nodeId: 'n2', leaseExpiresAt: future }, 'n1')).toBe(
      false,
    );
  });

  it('refuses a result arriving after the lease expired, so a resurrected node cannot overwrite newer work', () => {
    expect(FailoverService.holdsValidLease({ nodeId: 'n1', leaseExpiresAt: past }, 'n1')).toBe(
      false,
    );
  });

  it('refuses a result for a task holding no lease at all', () => {
    expect(FailoverService.holdsValidLease({ nodeId: 'n1', leaseExpiresAt: null }, 'n1')).toBe(
      false,
    );
  });
});

describe('task timeouts', () => {
  const withMetadata = (metadata: unknown) => ({ metadata }) as DistributedTask;

  it('uses the declared timeout when there is one', () => {
    expect(DistributedExecutionService.timeoutOf(withMetadata({ timeoutMs: 5_000 }))).toBe(5_000);
  });

  it('falls back to the default for a missing or nonsensical value', () => {
    const fallback = DistributedExecutionService.DEFAULT_TIMEOUT_MS;
    expect(DistributedExecutionService.timeoutOf(withMetadata({}))).toBe(fallback);
    expect(DistributedExecutionService.timeoutOf(withMetadata({ timeoutMs: -1 }))).toBe(fallback);
    expect(DistributedExecutionService.timeoutOf(withMetadata({ timeoutMs: 'soon' }))).toBe(
      fallback,
    );
    expect(DistributedExecutionService.timeoutOf(withMetadata(null))).toBe(fallback);
  });
});
