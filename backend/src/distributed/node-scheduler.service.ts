import { Injectable, Logger } from '@nestjs/common';
import { Node, NodeCapability, NodeStatus } from '@prisma/client';
import { NodeRepository } from '../database/repositories/distributed.repositories';
import { NodeRequirements, capabilityKey } from '../nodes/node.contract';

export type SchedulableNode = Node & { capabilities?: NodeCapability[] };

export interface PlacementFactor {
  name: string;
  weight: number;
  /** 0..1, before weighting. */
  score: number;
}

export interface PlacementCandidate {
  nodeId: string;
  slug: string;
  score: number;
  factors: PlacementFactor[];
}

export interface PlacementRejection {
  nodeId: string;
  slug: string;
  reason: string;
}

export interface Placement {
  node: SchedulableNode | null;
  candidates: PlacementCandidate[];
  rejected: PlacementRejection[];
  /** Human-readable account of why the winner won, for the monitor and logs. */
  explanation: string;
}

/**
 * Chooses which machine runs a piece of work.
 *
 * Two stages, in this order and never merged: **eligibility** is a set of
 * hard predicates a node either satisfies or does not, and **preference** is
 * a weighted score among those that do. Keeping them apart is what makes the
 * outcome explainable — a node that was never eligible is reported as
 * rejected with a reason, rather than quietly scoring zero and looking like
 * it merely lost.
 *
 * The weights encode a specific claim about what makes a placement good:
 * a healthy node matters most, then one that is not already saturated, then
 * one that is close by, and cost breaks ties. None of the individual signals
 * is authoritative on its own, which is why no single one can veto — except
 * the eligibility rules, which are absolute.
 */
@Injectable()
export class NodeScheduler {
  private readonly logger = new Logger(NodeScheduler.name);

  static readonly WEIGHTS = {
    health: 0.3,
    capacity: 0.25,
    latency: 0.15,
    hardware: 0.12,
    capability: 0.1,
    cost: 0.08,
  } as const;

  /** Latency past which a node scores zero on proximity. */
  static readonly LATENCY_CEILING_MS = 1_000;
  /** Hourly cost past which a node scores zero on price. */
  static readonly COST_CEILING_USD = 10;

  constructor(private readonly nodes: NodeRepository) {}

  /**
   * Picks a node for a task, or explains why none could be picked.
   *
   * Returns rather than throws on failure: "no node can run this" is an
   * ordinary scheduling outcome that the coordinator handles by leaving the
   * task queued, not an error condition. It only becomes a failure once the
   * task has waited past its retry budget.
   */
  async place(
    requirements: NodeRequirements = {},
    options: { exclude?: string[]; pool?: SchedulableNode[] } = {},
  ): Promise<Placement> {
    const pool = options.pool ?? ((await this.nodes.candidates()) as SchedulableNode[]);
    return NodeScheduler.rank(pool, requirements, options.exclude ?? []);
  }

  /**
   * Pure ranking, separated from data access so the policy can be tested
   * exhaustively without a database behind it.
   */
  static rank(
    pool: SchedulableNode[],
    requirements: NodeRequirements = {},
    exclude: string[] = [],
  ): Placement {
    const candidates: PlacementCandidate[] = [];
    const rejected: PlacementRejection[] = [];

    for (const node of pool) {
      const reason = NodeScheduler.ineligibleReason(node, requirements, exclude);
      if (reason) {
        rejected.push({ nodeId: node.id, slug: node.slug, reason });
        continue;
      }
      candidates.push(NodeScheduler.scoreNode(node, requirements));
    }

    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates[0];
    const node = winner ? pool.find((n) => n.id === winner.nodeId) ?? null : null;

    return {
      node,
      candidates,
      rejected,
      explanation: NodeScheduler.explain(winner, candidates, rejected),
    };
  }

  // ----------------------------------------------------------------
  // Eligibility — absolute, and the only thing that can exclude a node
  // ----------------------------------------------------------------

  static ineligibleReason(
    node: SchedulableNode,
    requirements: NodeRequirements,
    exclude: string[],
  ): string | null {
    if (exclude.includes(node.id)) return 'excluded by caller (already tried)';
    if (requirements.nodeId && node.id !== requirements.nodeId) return 'not the pinned node';
    if (node.deletedAt) return 'deleted';
    if (!node.allowRemoteExecution) return 'execution disabled on this node';
    if (node.trust !== 'TRUSTED') return `trust is ${node.trust}`;

    if (
      node.status !== NodeStatus.ONLINE &&
      node.status !== NodeStatus.DEGRADED
    ) {
      return `status is ${node.status}`;
    }

    if (node.quarantinedUntil && node.quarantinedUntil > new Date()) {
      return 'quarantined';
    }

    // A node at its concurrency ceiling is not "worse", it is full. Scoring
    // it low would still let it win when every node is saturated, which is
    // exactly when overcommitting does the most damage.
    if (node.activeTasks >= node.maxConcurrency) {
      return `at capacity (${node.activeTasks}/${node.maxConcurrency})`;
    }

    if (requirements.region && node.region !== requirements.region) {
      return `wrong region (${node.region})`;
    }

    for (const label of requirements.labels ?? []) {
      if (!node.labels.includes(label)) return `missing label "${label}"`;
    }

    if (requirements.requiresGpu && node.gpuCount <= 0) return 'no GPU';
    if (requirements.minCpuCores && node.cpuCores < requirements.minCpuCores) {
      return `too few cores (${node.cpuCores} < ${requirements.minCpuCores})`;
    }
    if (requirements.minMemoryMb && node.memoryMb < requirements.minMemoryMb) {
      return `too little memory (${node.memoryMb}MB < ${requirements.minMemoryMb}MB)`;
    }
    // Disk of 0 means "not reported" rather than "no disk" — refusing a node
    // for failing to measure something is worse than trying it.
    if (
      requirements.minDiskMb &&
      node.diskMb > 0 &&
      node.diskMb < requirements.minDiskMb
    ) {
      return `too little disk (${node.diskMb}MB < ${requirements.minDiskMb}MB)`;
    }

    if (
      requirements.maxCostPerHourUsd !== undefined &&
      node.costPerHourUsd > requirements.maxCostPerHourUsd
    ) {
      return `too expensive ($${node.costPerHourUsd}/h)`;
    }

    const missing = NodeScheduler.missingCapabilities(node, requirements.capabilities ?? []);
    if (missing.length > 0) return `missing capability ${missing.join(', ')}`;

    return null;
  }

  static missingCapabilities(node: SchedulableNode, required: string[]): string[] {
    if (required.length === 0) return [];
    const available = new Set(
      (node.capabilities ?? [])
        .filter((c) => c.available)
        .map((c) => capabilityKey(c.kind, c.key)),
    );
    return required
      .map((r) => (r.includes(':') ? r.toUpperCase() : capabilityKey('PROVIDER', r)))
      .filter((r) => !available.has(r));
  }

  // ----------------------------------------------------------------
  // Preference
  // ----------------------------------------------------------------

  static scoreNode(node: SchedulableNode, requirements: NodeRequirements): PlacementCandidate {
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    const w = NodeScheduler.WEIGHTS;

    const capacity =
      node.maxConcurrency > 0 ? clamp(1 - node.activeTasks / node.maxConcurrency) : 0;

    const latency = clamp(1 - node.latencyMs / NodeScheduler.LATENCY_CEILING_MS);

    // Headroom, not absolute size: a big machine already under load is a
    // worse home for new work than a small idle one.
    const hardware = clamp(
      (clamp(1 - node.cpuUsage) + clamp(1 - node.memoryUsage) + (node.gpuCount > 0 ? 1 : 0.5)) / 3,
    );

    // Capability is binary at the eligibility stage; here it rewards a node
    // that carries *more* than the minimum, since that node can also absorb
    // whatever comes next without another placement decision.
    const advertised = (node.capabilities ?? []).filter((c) => c.available).length;
    const capability = clamp(advertised / 12);

    const cost = clamp(1 - node.costPerHourUsd / NodeScheduler.COST_CEILING_USD);

    const factors: PlacementFactor[] = [
      { name: 'health', weight: w.health, score: clamp(node.healthScore) },
      { name: 'capacity', weight: w.capacity, score: capacity },
      { name: 'latency', weight: w.latency, score: latency },
      { name: 'hardware', weight: w.hardware, score: hardware },
      { name: 'capability', weight: w.capability, score: capability },
      { name: 'cost', weight: w.cost, score: cost },
    ];

    const score = factors.reduce((total, f) => total + f.weight * f.score, 0);

    return {
      nodeId: node.id,
      slug: node.slug,
      score: Number(score.toFixed(4)),
      factors: factors.map((f) => ({ ...f, score: Number(f.score.toFixed(4)) })),
    };
  }

  private static explain(
    winner: PlacementCandidate | undefined,
    candidates: PlacementCandidate[],
    rejected: PlacementRejection[],
  ): string {
    if (!winner) {
      if (rejected.length === 0) return 'No nodes are registered.';
      const reasons = rejected.slice(0, 5).map((r) => `${r.slug}: ${r.reason}`);
      return `No eligible node. ${reasons.join('; ')}`;
    }

    const top = [...winner.factors]
      .sort((a, b) => b.weight * b.score - a.weight * a.score)
      .slice(0, 2)
      .map((f) => `${f.name} ${f.score}`)
      .join(', ');

    const runnerUp = candidates[1];
    const margin = runnerUp
      ? ` (ahead of ${runnerUp.slug} by ${(winner.score - runnerUp.score).toFixed(3)})`
      : ' (only eligible node)';

    return `Chose ${winner.slug} at ${winner.score} on ${top}${margin}.`;
  }
}
