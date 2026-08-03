import { CapabilityKind, Node, NodeType } from '@prisma/client';

/**
 * Everything a node reports about itself.
 *
 * Nothing here is configuration a human maintains. A node measures its own
 * machine and says so; the control plane records it and schedules on it. That
 * is what makes "add capacity by registering a node" true rather than
 * aspirational — there is no second place to go and describe the hardware.
 */
export interface NodeResources {
  cpuCores?: number;
  cpuModel?: string;
  memoryMb?: number;
  diskMb?: number;
  gpuCount?: number;
  gpuModel?: string;
  gpuMemoryMb?: number;
}

export interface NodeLoad {
  cpuUsage?: number;
  memoryUsage?: number;
  diskUsage?: number;
  gpuUsage?: number;
  activeTasks?: number;
  queueDepth?: number;
  uptimeSeconds?: number;
}

export interface CapabilityReport {
  kind: CapabilityKind;
  /** Provider kind, tool key, extension slug or runtime identifier. */
  key: string;
  name?: string;
  version?: string;
  detail?: Record<string, unknown>;
}

export interface HeartbeatReport extends NodeLoad {
  /** Round-trip latency the node observed talking to the control plane. */
  latencyMs?: number;
  resources?: NodeResources;
  capabilities?: CapabilityReport[];
  details?: Record<string, unknown>;
}

/** What the scheduler must satisfy before a node can take a task. */
export interface NodeRequirements {
  /** Capability keys that must all be present, e.g. `["PROVIDER:OPENAI"]`. */
  capabilities?: string[];
  requiresGpu?: boolean;
  minMemoryMb?: number;
  minCpuCores?: number;
  minDiskMb?: number;
  /** Every label listed must be present on the node. */
  labels?: string[];
  region?: string;
  /** Hard pin. Set by `Worker.preferredNodeId` or an explicit dispatch. */
  nodeId?: string;
  /** Ceiling on the node's hourly cost. */
  maxCostPerHourUsd?: number;
  /** Organization that owns the nodes being considered, when federated. */
  ownerOrganizationId?: string;
}

/** One unit of work handed to a node, whatever the transport. */
export interface NodeDispatch {
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  organizationId: string;
  /** Milliseconds the node may take before the control plane gives up. */
  timeoutMs: number;
  /** Correlates the dispatch across control-plane and node logs. */
  correlationId?: string;
}

export interface NodeDispatchResult {
  taskId: string;
  status: 'SUCCEEDED' | 'FAILED';
  result?: Record<string, unknown>;
  error?: string;
  /** True when the failure is worth trying on a different node. */
  retryable?: boolean;
  durationMs: number;
  costUsd?: number;
  totalTokens?: number;
  /** Node that actually produced the result. */
  nodeId: string;
}

/**
 * How the control plane reaches a node.
 *
 * The three implementations are not variations on a theme, they are three
 * genuinely different situations: the node is this process, the node is
 * another machine, or the node is a stand-in used to exercise fleet
 * behaviour without a second machine to hand. Selection, failover, migration
 * and accounting sit above this interface and are identical in all three
 * cases, which is the point — distribution is a transport concern, not a
 * different execution model.
 */
export interface INodeTransport {
  /** Matches the `transport` resolved for a node. */
  readonly key: string;

  /** Hand work to the node and wait for its verdict. */
  dispatch(node: Node, dispatch: NodeDispatch): Promise<NodeDispatchResult>;

  /** Liveness and capability probe. Used at registration and by the monitor. */
  probe(node: Node): Promise<{ reachable: boolean; latencyMs: number; report?: HeartbeatReport }>;

  /** Best-effort cancellation. Not every transport can honour it. */
  cancel?(node: Node, taskId: string): Promise<void>;
}

/** Node types that never involve a network hop. */
export const IN_PROCESS_NODE_TYPES: NodeType[] = [];

/** Canonical capability key, e.g. `PROVIDER:OPENAI`. */
export function capabilityKey(kind: CapabilityKind | string, key: string): string {
  return `${kind}:${key}`.toUpperCase();
}
