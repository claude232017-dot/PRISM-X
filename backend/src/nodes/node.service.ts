import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { CapabilityKind, Node, NodeStatus, NodeType } from '@prisma/client';
import { cpus, freemem, totalmem, uptime } from 'node:os';
import {
  NodeCapabilityRepository,
  NodeHeartbeatRepository,
  NodeRepository,
} from '../database/repositories/distributed.repositories';
import {
  ExtensionRepository,
  ProviderRepository,
} from '../database/repositories/tenant.repositories';
import { ToolRegistry } from '../tools/tool-registry.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { EgressBlockedError, validateUrl } from '../shared/http/egress-guard';
import { internalNodeTransport } from '../shared/http/egress-policies';
import { NodeSecurityService, IssuedNodeSecret } from './node-security.service';
import { CapabilityReport, HeartbeatReport, NodeResources } from './node.contract';

export interface RegisterNodeInput {
  name: string;
  slug?: string;
  type?: NodeType;
  endpointUrl?: string;
  region?: string;
  labels?: string[];
  version?: string;
  maxConcurrency?: number;
  costPerHourUsd?: number;
  allowRemoteExecution?: boolean;
  resources?: NodeResources;
  capabilities?: CapabilityReport[];
  /** Marks this as the control plane's own node. At most one per tenant. */
  isLocal?: boolean;
  /** Registration is signed; an unsigned one lands UNVERIFIED and idle. */
  trusted?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RegisteredNode {
  node: Node;
  /** Present only on first registration and on rotation. */
  credentials?: IssuedNodeSecret;
}

/**
 * The fleet register.
 *
 * A node's row is mostly *reported* state — hardware, capabilities, load,
 * health — refreshed by the node itself on every heartbeat. The control
 * plane's own contribution is the parts a machine cannot decide about
 * itself: whether it is trusted, whether it may take work, and how it scores
 * against its peers.
 *
 * Health is a single 0..1 number because the scheduler needs one comparable
 * quantity, but it is composed from separate signals (freshness, resource
 * pressure, recent failures) so a node that is merely busy is not confused
 * with one that is failing.
 */
@Injectable()
export class NodeService implements OnModuleInit {
  private readonly logger = new Logger(NodeService.name);

  /** No heartbeat for this long and a node is presumed gone. */
  static readonly HEARTBEAT_TIMEOUT_MS = 90_000;
  /** Health below this and a node is DEGRADED rather than ONLINE. */
  static readonly DEGRADED_THRESHOLD = 0.4;
  /** Consecutive dispatch failures before a node is quarantined. */
  static readonly QUARANTINE_AFTER_FAILURES = 3;
  static readonly QUARANTINE_MS = 5 * 60 * 1000;

  constructor(
    private readonly nodes: NodeRepository,
    private readonly capabilities: NodeCapabilityRepository,
    private readonly heartbeats: NodeHeartbeatRepository,
    private readonly providers: ProviderRepository,
    private readonly extensions: ExtensionRepository,
    private readonly tools: ToolRegistry,
    private readonly security: NodeSecurityService,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void {
    // A new organization gets its control-plane node immediately, so the
    // fleet is never empty and the scheduler always has at least the
    // degenerate choice. Registering a second machine is then the only
    // thing "adding capacity" ever means.
    this.events.on(DomainEvent.OrganizationCreated, async (event) => {
      try {
        await RequestContextStore.run(
          {
            userId: event.actorId ?? 'system',
            organizationId: event.organizationId,
            roleKey: 'SYSTEM',
            permissions: ['*'],
            requestId: `node-bootstrap-${Date.now()}`,
          },
          () => this.ensureLocalNode(),
        );
      } catch (error) {
        // A failure here costs the organization its automatic local node,
        // which `POST /nodes/local` can still create. It must not fail the
        // registration that triggered it.
        this.logger.warn(`Could not create local node: ${(error as Error).message}`);
      }
    });

    // Anything that changes what this process can do changes what the
    // scheduler may place on it. Rediscovering on those events is what makes
    // capability tracking automatic rather than a thing someone must remember
    // to re-run after connecting a provider.
    for (const name of [
      DomainEvent.ProviderConnected,
      DomainEvent.ProviderDisconnected,
      DomainEvent.ExtensionInstalled,
      DomainEvent.ExtensionEnabled,
      DomainEvent.ExtensionDisabled,
    ]) {
      this.events.on(name, (event) => this.refreshLocalCapabilities(event.organizationId));
    }

    this.logger.log('Node manager ready');
  }

  /**
   * Re-reads this process's capabilities into its node row.
   *
   * Best-effort and silent on failure: it is a cache refresh, and losing one
   * must not fail the provider or extension change that prompted it.
   */
  private async refreshLocalCapabilities(organizationId: string): Promise<void> {
    try {
      await RequestContextStore.run(
        {
          userId: 'system',
          organizationId,
          roleKey: 'SYSTEM',
          permissions: ['*'],
          requestId: `node-discover-${Date.now()}`,
        },
        async () => {
          const local = await this.nodes.findLocal();
          if (!local) return;
          await this.syncCapabilities(local.id, await this.discoverLocal());
        },
      );
    } catch (error) {
      this.logger.warn(`Local capability refresh failed: ${(error as Error).message}`);
    }
  }

  // ----------------------------------------------------------------
  // Registration
  // ----------------------------------------------------------------

  /**
   * Adds a machine to the fleet.
   *
   * This is the whole of "adding capacity". Everything downstream —
   * discovery, measurement, rescheduling, rebalancing — follows from the row
   * created here plus the heartbeats that follow it. There is no second
   * configuration step, and nothing else in the system needs to be told that
   * the fleet got bigger.
   */
  async register(input: RegisterNodeInput): Promise<RegisteredNode> {
    const slug = NodeService.slugify(input.slug ?? input.name);
    if (!slug) throw new BadRequestException('Node name must contain a usable character');

    const existing = await this.nodes.findBySlug(slug);
    if (existing) {
      throw new ConflictException(`A node with slug "${slug}" already exists`);
    }

    if (input.isLocal) {
      const local = await this.nodes.findLocal();
      if (local) {
        throw new ConflictException(
          `This organization already has a local node ("${local.slug}"). ` +
            'The control plane runs as exactly one node.',
        );
      }
    }

    if (!input.isLocal && !input.endpointUrl) {
      throw new BadRequestException(
        'A remote node needs an endpointUrl the control plane can reach it on',
      );
    }

    if (input.endpointUrl) NodeService.assertEndpointPermitted(input.endpointUrl);

    const resources = input.resources ?? {};
    const node = await this.nodes.create({
      name: input.name,
      slug,
      type: input.type ?? NodeType.CUSTOM,
      status: NodeStatus.PENDING,
      endpointUrl: input.endpointUrl ?? null,
      isLocal: input.isLocal ?? false,
      region: input.region ?? 'default',
      version: input.version ?? null,
      labels: input.labels ?? [],
      maxConcurrency: input.maxConcurrency ?? 4,
      costPerHourUsd: input.costPerHourUsd ?? 0,
      allowRemoteExecution: input.allowRemoteExecution ?? true,
      // A node registered without proof of identity is recorded but idle:
      // the scheduler only considers TRUSTED nodes, so an unverified
      // machine can sit in the fleet indefinitely without ever running work.
      trust: input.trusted ? 'TRUSTED' : 'UNVERIFIED',
      metadata: (input.metadata ?? {}) as never,
      ...NodeService.resourceColumns(resources),
    });

    const credentials = await this.security.issueInitialKey(node.id);

    const reported = input.capabilities ?? (input.isLocal ? await this.discoverLocal() : []);
    if (reported.length > 0) {
      await this.capabilities.replaceForNode(node.id, reported);
    }

    await this.events.publish(DomainEvent.NodeRegistered, {
      nodeId: node.id,
      slug: node.slug,
      type: node.type,
      isLocal: node.isLocal,
      trust: node.trust,
      capabilities: reported.length,
    });

    return { node: await this.nodes.findByIdOrFail(node.id), credentials };
  }

  /**
   * Ensures the control plane has a node row for itself.
   *
   * Without this a single-machine install would have an empty fleet and the
   * scheduler nothing to choose from, so the distributed path would be
   * strictly worse than the non-distributed one. The local node makes the
   * degenerate one-machine case an ordinary member of the general case.
   */
  async ensureLocalNode(name = 'Control Plane'): Promise<Node> {
    const existing = await this.nodes.findLocal();
    if (existing) {
      // Re-measure rather than returning the row as it stands. The local
      // node has no agent to heartbeat it, so without this its capabilities
      // would be frozen at whatever existed when the organization was
      // created — before its first provider was ever connected — and the
      // scheduler would refuse it work it can plainly do.
      return this.heartbeat(existing.id, {
        ...NodeService.measureLocalLoad(),
        resources: NodeService.measureLocalResources(),
        capabilities: await this.discoverLocal(),
      });
    }

    const { node } = await this.register({
      name,
      slug: 'control-plane',
      type: NodeType.LOCAL_MACHINE,
      isLocal: true,
      trusted: true,
      maxConcurrency: 8,
      resources: NodeService.measureLocalResources(),
      capabilities: await this.discoverLocal(),
    });

    return this.heartbeat(node.id, {
      ...NodeService.measureLocalLoad(),
      resources: NodeService.measureLocalResources(),
    });
  }

  // ----------------------------------------------------------------
  // Heartbeats, discovery and health
  // ----------------------------------------------------------------

  /**
   * Records a heartbeat and re-derives the node's status.
   *
   * This is the only place a node transitions between ONLINE, DEGRADED and
   * recovered-from-OFFLINE, because those are statements about liveness and
   * liveness is exactly what a heartbeat evidences. Operator-driven states
   * (DRAINING, DECOMMISSIONED) are left alone — a heartbeat is not consent.
   */
  async heartbeat(nodeId: string, report: HeartbeatReport = {}): Promise<Node> {
    const node = await this.nodes.findByIdOrFail(nodeId);

    if (report.resources) {
      await this.nodes.update(nodeId, NodeService.resourceColumns(report.resources));
    }

    if (report.capabilities && report.capabilities.length > 0) {
      await this.syncCapabilities(nodeId, report.capabilities);
    }

    const health = NodeService.scoreHealth({
      cpuUsage: report.cpuUsage ?? 0,
      memoryUsage: report.memoryUsage ?? 0,
      diskUsage: report.diskUsage ?? 0,
      activeTasks: report.activeTasks ?? node.activeTasks,
      maxConcurrency: node.maxConcurrency,
      consecutiveFailures: node.consecutiveFailures,
      ageMs: 0,
    });

    const wasDown = node.status === NodeStatus.OFFLINE || node.status === NodeStatus.PENDING;
    const nextStatus = NodeService.deriveStatus(node, health);

    // Latency is smoothed rather than replaced so one slow round trip on a
    // congested link does not evict an otherwise good node.
    const latencyMs =
      report.latencyMs === undefined
        ? node.latencyMs
        : node.latencyMs === 0
          ? report.latencyMs
          : node.latencyMs * 0.7 + report.latencyMs * 0.3;

    const updated = await this.nodes.update(nodeId, {
      status: nextStatus,
      cpuUsage: report.cpuUsage ?? node.cpuUsage,
      memoryUsage: report.memoryUsage ?? node.memoryUsage,
      diskUsage: report.diskUsage ?? node.diskUsage,
      gpuUsage: report.gpuUsage ?? node.gpuUsage,
      activeTasks: report.activeTasks ?? node.activeTasks,
      queueDepth: report.queueDepth ?? node.queueDepth,
      uptimeSeconds: report.uptimeSeconds ?? node.uptimeSeconds,
      latencyMs,
      healthScore: health,
      lastHeartbeatAt: new Date(),
    });

    await this.heartbeats.create({
      nodeId,
      status: nextStatus,
      cpuUsage: updated.cpuUsage,
      memoryUsage: updated.memoryUsage,
      diskUsage: updated.diskUsage,
      gpuUsage: updated.gpuUsage,
      activeTasks: updated.activeTasks,
      queueDepth: updated.queueDepth,
      latencyMs: updated.latencyMs,
      uptimeSeconds: updated.uptimeSeconds,
      healthScore: health,
      details: (report.details ?? {}) as never,
    });

    await this.events.publish(DomainEvent.NodeHeartbeatReceived, {
      nodeId,
      status: nextStatus,
      healthScore: Number(health.toFixed(3)),
    });

    if (wasDown && nextStatus === NodeStatus.ONLINE) {
      await this.nodes.update(nodeId, { consecutiveFailures: 0, quarantinedUntil: null });
      await this.events.publish(DomainEvent.NodeRecovered, { nodeId, from: node.status });
    } else if (node.status !== nextStatus) {
      const name =
        nextStatus === NodeStatus.DEGRADED ? DomainEvent.NodeDegraded : DomainEvent.NodeOnline;
      await this.events.publish(name, { nodeId, from: node.status, to: nextStatus });
    }

    return this.nodes.findByIdOrFail(nodeId);
  }

  /** Replaces a node's advertised capabilities from a discovery report. */
  async syncCapabilities(nodeId: string, reported: CapabilityReport[]): Promise<number> {
    const count = await this.capabilities.replaceForNode(nodeId, reported);
    await this.events.publish(DomainEvent.NodeCapabilitiesDiscovered, {
      nodeId,
      count,
      keys: reported.map((c) => `${c.kind}:${c.key}`),
    });
    return count;
  }

  /**
   * What this process can actually do, read from live state rather than
   * declared: connected providers, registered tools, enabled extensions.
   */
  async discoverLocal(): Promise<CapabilityReport[]> {
    const reports: CapabilityReport[] = [];

    const providers = await this.providers.findMany({ status: 'CONNECTED' });
    for (const provider of providers) {
      reports.push({
        kind: CapabilityKind.PROVIDER,
        key: provider.kind,
        name: provider.name,
        detail: { providerId: provider.id, model: provider.defaultModel },
      });
      if (provider.defaultModel) {
        reports.push({
          kind: CapabilityKind.MODEL,
          key: provider.defaultModel,
          name: provider.name,
          detail: { providerId: provider.id },
        });
      }
    }

    for (const key of this.tools.keys()) {
      reports.push({ kind: CapabilityKind.TOOL, key });
    }

    const extensions = await this.extensions.findMany({ status: 'ENABLED' });
    for (const extension of extensions) {
      reports.push({
        kind: CapabilityKind.EXTENSION,
        key: extension.slug,
        name: extension.name,
        version: extension.version,
      });
    }

    reports.push({
      kind: CapabilityKind.RUNTIME,
      key: 'NODEJS',
      version: process.version,
      detail: { platform: process.platform, arch: process.arch },
    });

    const resources = NodeService.measureLocalResources();
    if ((resources.gpuCount ?? 0) > 0) {
      reports.push({ kind: CapabilityKind.HARDWARE, key: 'GPU', detail: { ...resources } });
    }

    // Duplicate keys are possible when two providers share a default model;
    // the unique index is (node, kind, key), so collapse before writing.
    const seen = new Set<string>();
    return reports.filter((r) => {
      const id = `${r.kind}:${r.key}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  async list(where: Record<string, unknown> = {}): Promise<Node[]> {
    return this.nodes.findMany(where, {
      orderBy: { healthScore: 'desc' },
      include: { capabilities: true },
    });
  }

  async get(id: string): Promise<Node> {
    const node = await this.nodes.withCapabilities(id);
    if (!node) return this.nodes.findByIdOrFail(id);
    return node;
  }

  async trust(id: string, trusted: boolean): Promise<Node> {
    const node = await this.nodes.update(id, {
      trust: trusted ? 'TRUSTED' : 'REVOKED',
    });
    if (!trusted) {
      // Revoking trust without revoking keys would leave a node able to
      // authenticate while being refused work — a confusing half-state.
      await this.security.revokeAll(id);
    }
    await this.events.publish(DomainEvent.NodeTrustChanged, {
      nodeId: id,
      trust: node.trust,
    });
    return node;
  }

  /** Issues a new key version, keeping the old one valid during the overlap. */
  async rotateKey(id: string): Promise<IssuedNodeSecret> {
    const node = await this.nodes.findByIdOrFail(id);
    const issued = await this.security.rotate(node);
    await this.nodes.update(id, { keyVersion: issued.keyVersion });
    return issued;
  }

  /** Stops new placements while letting running work finish. */
  async drain(id: string, reason = 'operator request'): Promise<Node> {
    const node = await this.nodes.update(id, {
      status: NodeStatus.DRAINING,
      drainReason: reason,
    });
    await this.events.publish(DomainEvent.NodeDraining, { nodeId: id, reason });
    return node;
  }

  async resume(id: string): Promise<Node> {
    const node = await this.nodes.update(id, {
      status: NodeStatus.ONLINE,
      drainReason: null,
      consecutiveFailures: 0,
      quarantinedUntil: null,
    });
    await this.events.publish(DomainEvent.NodeRecovered, { nodeId: id, from: 'DRAINING' });
    return node;
  }

  async decommission(id: string): Promise<Node> {
    const node = await this.nodes.update(id, {
      status: NodeStatus.DECOMMISSIONED,
      allowRemoteExecution: false,
    });
    await this.security.revokeAll(id);
    await this.events.publish(DomainEvent.NodeDecommissioned, { nodeId: id });
    return node;
  }

  async markOffline(id: string, reason: string): Promise<Node> {
    const node = await this.nodes.update(id, {
      status: NodeStatus.OFFLINE,
      healthScore: 0,
    });
    await this.events.publish(DomainEvent.NodeOffline, { nodeId: id, reason });
    return node;
  }

  /**
   * Counts a dispatch failure and quarantines the node once they pile up.
   *
   * The threshold exists because one failure is noise — a transient network
   * blip, a task that would have failed anywhere. Three in a row is a
   * property of the node, and continuing to send it work would convert one
   * sick machine into a fleet-wide failure rate.
   */
  async recordFailure(id: string): Promise<Node> {
    const node = await this.nodes.findByIdOrFail(id);
    const failures = node.consecutiveFailures + 1;

    if (failures >= NodeService.QUARANTINE_AFTER_FAILURES) {
      const until = new Date(Date.now() + NodeService.QUARANTINE_MS);
      const quarantined = await this.nodes.update(id, {
        consecutiveFailures: failures,
        quarantinedUntil: until,
        status: NodeStatus.QUARANTINED,
      });
      await this.events.publish(DomainEvent.NodeQuarantined, {
        nodeId: id,
        failures,
        until: until.toISOString(),
      });
      return quarantined;
    }

    return this.nodes.update(id, { consecutiveFailures: failures });
  }

  async recordSuccess(id: string): Promise<void> {
    const node = await this.nodes.findById(id);
    if (node && node.consecutiveFailures > 0) {
      await this.nodes.update(id, { consecutiveFailures: 0 });
    }
  }

  // ----------------------------------------------------------------
  // Pure helpers — kept static so they can be tested without a database
  // ----------------------------------------------------------------

  /**
   * Collapses several independent signals into one comparable number.
   *
   * Three of the signals are weighted and summed — resource headroom,
   * spare concurrency, recent reliability — because each can be poor without
   * making the node useless. Freshness is not one of them: it *multiplies*.
   *
   * That asymmetry is deliberate. A node that has gone quiet is not
   * partially healthy, it is unknown, and unknown must decay toward zero
   * rather than bottoming out at whatever the other terms happen to
   * contribute. Summing freshness in would put a floor under every score, so
   * a machine pinned at 98% CPU with a full queue would still land above the
   * degraded threshold purely because it was answering the phone.
   */
  static scoreHealth(input: {
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
    activeTasks: number;
    maxConcurrency: number;
    consecutiveFailures: number;
    ageMs: number;
  }): number {
    const clamp = (n: number) => Math.min(1, Math.max(0, n));

    const resourcePressure =
      (clamp(input.cpuUsage) + clamp(input.memoryUsage) + clamp(input.diskUsage)) / 3;
    const loadRatio =
      input.maxConcurrency > 0 ? clamp(input.activeTasks / input.maxConcurrency) : 1;

    const freshness =
      input.ageMs <= 0
        ? 1
        : clamp(1 - input.ageMs / NodeService.HEARTBEAT_TIMEOUT_MS);

    const reliability = clamp(
      1 - input.consecutiveFailures / NodeService.QUARANTINE_AFTER_FAILURES,
    );

    const condition =
      0.5 * (1 - resourcePressure) + 0.3 * (1 - loadRatio) + 0.2 * reliability;

    return Number(clamp(condition * freshness).toFixed(4));
  }

  /** What a heartbeat implies about status, leaving operator states alone. */
  static deriveStatus(node: Node, health: number): NodeStatus {
    if (
      node.status === NodeStatus.DRAINING ||
      node.status === NodeStatus.DECOMMISSIONED
    ) {
      return node.status;
    }
    if (node.status === NodeStatus.QUARANTINED) {
      const held = node.quarantinedUntil && node.quarantinedUntil > new Date();
      if (held) return NodeStatus.QUARANTINED;
    }
    return health < NodeService.DEGRADED_THRESHOLD ? NodeStatus.DEGRADED : NodeStatus.ONLINE;
  }

  /**
   * Refuses a node endpoint the transport would refuse to dispatch to.
   *
   * The registration half of the `INTERNAL_NODE_TRANSPORT` policy. Dispatch
   * already enforces it — `HttpNodeTransport` passes the same policy to
   * `OutboundHttpService` on every call — so this check adds no security the
   * runtime lacks. What it adds is *timing*: an administrator who pastes
   * `http://169.254.169.254/` or an address outside the operator's declared
   * network learns immediately, in the response to their own request, instead
   * of registering a node that silently never receives work.
   *
   * Only the URL's shape and any IP *literal* are judged here. A hostname is
   * not resolved: registration is a synchronous request handler, DNS at this
   * point would be a tenant-triggered lookup with no timeout budget, and the
   * answer would be worthless anyway — the address that matters is the one the
   * name resolves to at dispatch, which is what the guard pins.
   *
   * Registration is the only path that writes `endpointUrl`; there is no
   * update path to also cover. If one is ever added it calls this too.
   */
  static assertEndpointPermitted(
    endpointUrl: string,
    env: NodeJS.ProcessEnv = process.env,
  ): void {
    try {
      validateUrl(endpointUrl, internalNodeTransport(env));
    } catch (error) {
      if (!(error instanceof EgressBlockedError)) throw error;
      throw new BadRequestException(
        `endpointUrl is not reachable under this deployment's node network ` +
          `policy — ${error.message}. Nodes at private addresses require ` +
          'NODE_ENDPOINT_ALLOWED_CIDRS to name the network they run on; no ' +
          'configuration permits a metadata or link-local address.',
      );
    }
  }

  static slugify(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  static resourceColumns(resources: NodeResources): Record<string, unknown> {
    const columns: Record<string, unknown> = {};
    if (resources.cpuCores !== undefined) columns.cpuCores = resources.cpuCores;
    if (resources.cpuModel !== undefined) columns.cpuModel = resources.cpuModel;
    if (resources.memoryMb !== undefined) columns.memoryMb = resources.memoryMb;
    if (resources.diskMb !== undefined) columns.diskMb = resources.diskMb;
    if (resources.gpuCount !== undefined) columns.gpuCount = resources.gpuCount;
    if (resources.gpuModel !== undefined) columns.gpuModel = resources.gpuModel;
    if (resources.gpuMemoryMb !== undefined) columns.gpuMemoryMb = resources.gpuMemoryMb;
    return columns;
  }

  /** Measures the machine this process is running on. */
  static measureLocalResources(): NodeResources {
    const cores = cpus();
    return {
      cpuCores: cores.length,
      cpuModel: cores[0]?.model?.trim() ?? 'unknown',
      memoryMb: Math.round(totalmem() / 1024 / 1024),
      // Disk is not available from `os` without a syscall per mount point;
      // a node agent reports it, and 0 reads as "not reported" everywhere
      // it is consumed rather than as "no disk".
      diskMb: 0,
      gpuCount: 0,
    };
  }

  static measureLocalLoad(): HeartbeatReport {
    const total = totalmem();
    return {
      cpuUsage: Math.min(1, Number((process.cpuUsage().user / 1e6 / uptime()).toFixed(4)) || 0),
      memoryUsage: total > 0 ? Number(((total - freemem()) / total).toFixed(4)) : 0,
      diskUsage: 0,
      uptimeSeconds: Math.round(uptime()),
    };
  }
}
