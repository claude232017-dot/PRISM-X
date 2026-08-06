import { BadRequestException } from '@nestjs/common';
import { Node, NodeStatus } from '@prisma/client';
import { NodeService } from './node.service';
import { NodeSecurityService } from './node-security.service';
import { NodeTransportRegistry, SimulatedNodeTransport } from './transport/node-transports';

const node = (over: Partial<Node> = {}): Node =>
  ({
    id: 'n1',
    organizationId: 'org1',
    name: 'Node',
    slug: 'node',
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
    healthScore: 1,
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
    ...over,
  }) as Node;

describe('node health scoring', () => {
  const score = (over: Partial<Parameters<typeof NodeService.scoreHealth>[0]> = {}) =>
    NodeService.scoreHealth({
      cpuUsage: 0,
      memoryUsage: 0,
      diskUsage: 0,
      activeTasks: 0,
      maxConcurrency: 4,
      consecutiveFailures: 0,
      ageMs: 0,
      ...over,
    });

  it('scores an idle, fresh, reliable node at full health', () => {
    expect(score()).toBe(1);
  });

  it('drops a saturated node below the degraded threshold', () => {
    const saturated = score({
      cpuUsage: 0.98,
      memoryUsage: 0.97,
      diskUsage: 0.95,
      activeTasks: 4,
    });
    expect(saturated).toBeLessThan(NodeService.DEGRADED_THRESHOLD);
  });

  it('decays toward zero as a heartbeat goes stale, rather than to a floor', () => {
    const fresh = score({ ageMs: 0 });
    const half = score({ ageMs: NodeService.HEARTBEAT_TIMEOUT_MS / 2 });
    const gone = score({ ageMs: NodeService.HEARTBEAT_TIMEOUT_MS * 2 });
    expect(half).toBeLessThan(fresh);
    expect(gone).toBe(0);
  });

  it('penalises consecutive failures', () => {
    expect(score({ consecutiveFailures: 2 })).toBeLessThan(score({ consecutiveFailures: 0 }));
  });

  it('treats load as separate from resource pressure', () => {
    const busy = score({ activeTasks: 4 });
    const stressed = score({ cpuUsage: 1, memoryUsage: 1, diskUsage: 1 });
    expect(busy).toBeGreaterThan(0);
    expect(stressed).toBeGreaterThan(0);
    expect(busy).not.toBe(stressed);
  });

  it('never leaves the 0..1 range even with nonsense input', () => {
    const wild = score({ cpuUsage: 12, memoryUsage: -4, activeTasks: 99, maxConcurrency: 1 });
    expect(wild).toBeGreaterThanOrEqual(0);
    expect(wild).toBeLessThanOrEqual(1);
  });
});

describe('status derivation', () => {
  it('promotes a healthy node to ONLINE', () => {
    expect(NodeService.deriveStatus(node({ status: NodeStatus.PENDING }), 0.9)).toBe(
      NodeStatus.ONLINE,
    );
  });

  it('marks an unhealthy node DEGRADED rather than removing it', () => {
    expect(NodeService.deriveStatus(node(), 0.1)).toBe(NodeStatus.DEGRADED);
  });

  it('leaves operator-chosen states alone — a heartbeat is not consent', () => {
    expect(NodeService.deriveStatus(node({ status: NodeStatus.DRAINING }), 1)).toBe(
      NodeStatus.DRAINING,
    );
    expect(NodeService.deriveStatus(node({ status: NodeStatus.DECOMMISSIONED }), 1)).toBe(
      NodeStatus.DECOMMISSIONED,
    );
  });

  it('holds a quarantine until it expires', () => {
    const held = node({
      status: NodeStatus.QUARANTINED,
      quarantinedUntil: new Date(Date.now() + 60_000),
    });
    expect(NodeService.deriveStatus(held, 1)).toBe(NodeStatus.QUARANTINED);
  });

  it('releases a node once its quarantine has elapsed', () => {
    const lapsed = node({
      status: NodeStatus.QUARANTINED,
      quarantinedUntil: new Date(Date.now() - 60_000),
    });
    expect(NodeService.deriveStatus(lapsed, 1)).toBe(NodeStatus.ONLINE);
  });
});

describe('slugs', () => {
  it.each([
    ['Home GPU Box', 'home-gpu-box'],
    ['  Edge  Pi  ', 'edge-pi'],
    ['node_01!!', 'node-01'],
    ['---', ''],
  ])('slugifies %s', (input, expected) => {
    expect(NodeService.slugify(input)).toBe(expected);
  });

  it('bounds the length so a slug stays usable in a URL', () => {
    expect(NodeService.slugify('x'.repeat(200)).length).toBe(60);
  });
});

describe('resource columns', () => {
  it('only writes the fields that were reported', () => {
    expect(NodeService.resourceColumns({ cpuCores: 8 })).toEqual({ cpuCores: 8 });
  });

  it('preserves an explicit zero, which is not the same as unreported', () => {
    expect(NodeService.resourceColumns({ gpuCount: 0 })).toEqual({ gpuCount: 0 });
  });

  it('reports nothing for an empty measurement', () => {
    expect(NodeService.resourceColumns({})).toEqual({});
  });
});

describe('transport selection', () => {
  it('reaches the control plane in-process', () => {
    expect(NodeTransportRegistry.transportKeyFor(node({ isLocal: true }))).toBe('local');
  });

  it('stands in for a node marked simulated', () => {
    expect(
      NodeTransportRegistry.transportKeyFor(node({ metadata: { simulate: { latencyMs: 10 } } })),
    ).toBe('simulated');
  });

  it('treats an ordinary node as a real machine over HTTP', () => {
    expect(NodeTransportRegistry.transportKeyFor(node())).toBe('http');
  });

  it('reads simulation settings with sane defaults', () => {
    expect(SimulatedNodeTransport.settings(node())).toMatchObject({
      latencyMs: 0,
      unreachable: false,
      failEvery: 0,
    });
    expect(
      SimulatedNodeTransport.settings(node({ metadata: { simulate: { unreachable: true } } })),
    ).toMatchObject({ unreachable: true });
  });
});

describe('node request signing', () => {
  const secret = 'node-shared-secret';
  const body = JSON.stringify({ taskId: 't1', kind: 'echo' });

  it('round-trips sign and verify', () => {
    const at = Math.floor(Date.now() / 1000);
    const signature = NodeSecurityService.sign(secret, at, body);
    expect(NodeSecurityService.verifySignature(secret, signature, at, body)).toBe(true);
  });

  it('produces the documented v1= format', () => {
    expect(NodeSecurityService.sign(secret, 1_700_000_000, body)).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('rejects a signature made with a different secret', () => {
    const at = Math.floor(Date.now() / 1000);
    const signature = NodeSecurityService.sign('other', at, body);
    expect(NodeSecurityService.verifySignature(secret, signature, at, body)).toBe(false);
  });

  it('rejects a body altered after signing', () => {
    const at = Math.floor(Date.now() / 1000);
    const signature = NodeSecurityService.sign(secret, at, body);
    expect(NodeSecurityService.verifySignature(secret, signature, at, `${body} `)).toBe(false);
  });

  it('rejects a captured request replayed later', () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const signature = NodeSecurityService.sign(secret, stale, body);
    expect(NodeSecurityService.verifySignature(secret, signature, stale, body)).toBe(false);
  });

  it('cannot be extended by pairing an old signature with a fresh timestamp', () => {
    const at = Math.floor(Date.now() / 1000) - 10;
    const signature = NodeSecurityService.sign(secret, at, body);
    const now = Math.floor(Date.now() / 1000);
    expect(NodeSecurityService.verifySignature(secret, signature, now, body)).toBe(false);
  });

  it('rejects a missing or malformed signature rather than defaulting to trust', () => {
    const at = Math.floor(Date.now() / 1000);
    expect(NodeSecurityService.verifySignature(secret, '', at, body)).toBe(false);
    expect(NodeSecurityService.verifySignature(secret, 'garbage', at, body)).toBe(false);
    expect(NodeSecurityService.verifySignature(secret, 'v1=abc', at, body)).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    const signature = NodeSecurityService.sign(secret, 1, body);
    expect(NodeSecurityService.verifySignature(secret, signature, Number.NaN, body)).toBe(false);
  });

  it('generates secrets with enough entropy to be unguessable, and distinct', () => {
    const a = NodeSecurityService.generateSecret();
    const b = NodeSecurityService.generateSecret();
    expect(a.length).toBeGreaterThanOrEqual(42);
    expect(a).not.toBe(b);
  });

  it('fingerprints a secret without revealing it', () => {
    const fingerprint = NodeSecurityService.fingerprint(secret);
    expect(fingerprint).toHaveLength(16);
    expect(secret).not.toContain(fingerprint);
    expect(NodeSecurityService.fingerprint(secret)).toBe(fingerprint);
  });
});

/**
 * Registration-time enforcement of the internal node transport policy.
 *
 * The dispatch path already enforces this — `HttpNodeTransport` passes the same
 * policy to `OutboundHttpService` on every request — so these tests are about
 * *when* an operator finds out, not about whether the guard holds. A node
 * registered at an address the transport will refuse is a node that silently
 * never receives work, and the administrator who typed it is long gone by the
 * time anyone notices.
 */
describe('node endpoint registration policy', () => {
  const permitted = (url: string, env: NodeJS.ProcessEnv) =>
    NodeService.assertEndpointPermitted(url, env);

  const development = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
  const production = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
  const declared = {
    NODE_ENV: 'production',
    NODE_ENDPOINT_ALLOWED_CIDRS: '10.20.0.0/16',
  } as NodeJS.ProcessEnv;

  it('refuses the cloud metadata service under every configuration', () => {
    for (const env of [development, production, declared]) {
      expect(() => permitted('http://169.254.169.254/latest/meta-data/', env)).toThrow(
        BadRequestException,
      );
    }
    // Including when an operator has tried to allow it explicitly.
    expect(() =>
      permitted('http://169.254.169.254/', {
        NODE_ENV: 'production',
        NODE_ENDPOINT_ALLOWED_CIDRS: '169.254.0.0/16',
      } as NodeJS.ProcessEnv),
    ).toThrow(BadRequestException);
  });

  it('refuses a metadata hostname', () => {
    expect(() => permitted('http://metadata.google.internal/', development)).toThrow(
      BadRequestException,
    );
  });

  it('refuses a private endpoint in production until the network is declared', () => {
    expect(() => permitted('http://10.20.4.7:8080/', production)).toThrow(
      BadRequestException,
    );
    expect(() => permitted('http://10.20.4.7:8080/', declared)).not.toThrow();
  });

  it('refuses an address outside the declared network', () => {
    expect(() => permitted('http://10.30.4.7:8080/', declared)).toThrow(
      BadRequestException,
    );
    expect(() => permitted('http://192.168.1.10:8080/', declared)).toThrow(
      BadRequestException,
    );
  });

  it('refuses a port that is not a node agent', () => {
    // The classic pivot: register a "node" pointing at the database.
    expect(() => permitted('http://10.20.0.5:5432/', declared)).toThrow(
      BadRequestException,
    );
    expect(() => permitted('http://10.20.0.5:6379/', declared)).toThrow(
      BadRequestException,
    );
  });

  it('refuses a scheme that is not HTTP', () => {
    for (const url of ['file:///etc/passwd', 'gopher://10.20.0.5/', 'ftp://10.20.0.5/']) {
      expect(() => permitted(url, declared)).toThrow(BadRequestException);
    }
  });

  it('refuses credentials embedded in the endpoint', () => {
    expect(() => permitted('http://user:pass@10.20.4.7:8080/', declared)).toThrow(
      BadRequestException,
    );
  });

  it('accepts a public endpoint, and a loopback one outside production', () => {
    expect(() => permitted('https://node.example.com/', production)).not.toThrow();
    expect(() => permitted('http://127.0.0.1:3100/', development)).not.toThrow();
  });

  it('accepts an internal hostname once a network is declared', () => {
    // The hostname is not resolved here — the address that matters is the one
    // it resolves to at dispatch, which is what the guard pins. This asserts
    // only that a name of this shape is not rejected out of hand.
    expect(() => permitted('https://gpu.example.internal/', declared)).not.toThrow();
  });

  it('reports a refusal as a client error naming the variable to set', () => {
    try {
      permitted('http://10.20.4.7:8080/', production);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain('NODE_ENDPOINT_ALLOWED_CIDRS');
    }
  });
});
