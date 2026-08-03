import { Injectable, Logger } from '@nestjs/common';
import { CandidateStatus, DeploymentStatus } from '@prisma/client';
import {
  ConstitutionViolationRepository,
  DeploymentRepository,
  EntityVersionRepository,
  EvolutionCandidateRepository,
  EvolutionExperimentRepository,
  PlanningStrategyRepository,
} from '../database/repositories/evolution.repositories';
import { EvolutionPolicyService } from './policy.service';
import * as Constitution from './constitution';
import * as Confidence from '../learning/confidence';

export interface EvolutionDigest {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  /** The one-line answer to "how has PRISM-X improved this month?" */
  headline: string;
  improvements: string[];

  candidates: {
    total: number;
    queued: number;
    testing: number;
    validated: number;
    deployed: number;
    rejected: number;
  };
  experiments: {
    active: Array<{ id: string; name: string; mode: string; exposure: string; controlTrials: number; variantTrials: number }>;
    concluded: number;
    better: number;
    worse: number;
    inconclusive: number;
  };
  deployments: {
    total: number;
    succeeded: number;
    rolledBack: number;
    refused: number;
    monitoring: number;
    /** Share of deployments that survived their monitoring window. */
    successRate: number;
  };
  rollbacks: Array<{
    id: string;
    subjectLabel: string;
    kind: string;
    reason: string | null;
    automatic: boolean;
    at: string | null;
  }>;
  timeline: Array<{
    at: string;
    event: 'deployed' | 'rolled_back' | 'refused';
    subjectLabel: string;
    kind: string;
    detail: string;
  }>;
  bestVersions: Array<{
    subject: string;
    subjectId: string;
    aspect: string;
    version: number;
    label: string | null;
    activatedAt: string | null;
  }>;
  planning: {
    active: string | null;
    missionsPlanned: number;
    successRate: number;
    strategies: number;
  };
  constitution: {
    version: string;
    laws: number;
    violations: number;
    byLaw: Array<{ lawId: string; count: number }>;
  };
  policy: {
    enabled: boolean;
    allowedKinds: string[];
    autoApproveThreshold: number;
    requiresApprovalFor: string[];
  };
  confidenceTrend: {
    direction: 'improving' | 'declining' | 'steady' | 'unknown';
    average: number;
    summary: string;
  };
}

/**
 * How the system has changed itself, on one screen.
 *
 * Composed from what the other services recorded; nothing is recomputed
 * here. A dashboard that derives its own success rates is one that can
 * disagree with the pipeline it reports on.
 *
 * The `improvements` list is the part that matters. A count of deployments
 * says the machinery ran; a sentence naming what got better says the system
 * improved — and when nothing did, saying so is the honest answer rather
 * than a page of charts implying otherwise. Refusals and rollbacks are given
 * the same prominence as successes, because an evolution dashboard that only
 * shows wins is a marketing page.
 */
@Injectable()
export class EvolutionDashboardService {
  private readonly logger = new Logger(EvolutionDashboardService.name);

  constructor(
    private readonly candidates: EvolutionCandidateRepository,
    private readonly experiments: EvolutionExperimentRepository,
    private readonly deployments: DeploymentRepository,
    private readonly versions: EntityVersionRepository,
    private readonly violations: ConstitutionViolationRepository,
    private readonly strategies: PlanningStrategyRepository,
    private readonly policy: EvolutionPolicyService,
  ) {}

  async digest(days = 30): Promise<EvolutionDigest> {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);

    const [
      allCandidates,
      runningExperiments,
      concludedExperiments,
      allDeployments,
      activeVersions,
      violations,
      byLaw,
      strategies,
      activeStrategy,
      policy,
    ] = await Promise.all([
      this.candidates.findMany({ createdAt: { gte: from } }, { take: 500 }),
      this.experiments.running(),
      this.experiments.findMany(
        { status: 'CONCLUDED', concludedAt: { gte: from } },
        { take: 200 },
      ),
      this.deployments.findMany({ createdAt: { gte: from } }, { take: 500, orderBy: { createdAt: 'desc' } }),
      this.versions.findMany({ isActive: true }, { take: 100, orderBy: { activatedAt: 'desc' } }),
      this.violations.findMany({ createdAt: { gte: from } }, { take: 200 }),
      this.violations.countByLaw(from),
      this.strategies.findMany({}, { take: 50 }),
      this.strategies.findActive(),
      this.policy.get(),
    ]);

    const byStatus = (status: CandidateStatus) =>
      allCandidates.filter((c) => c.status === status).length;

    const deployed = allDeployments.filter(
      (d) =>
        d.status === DeploymentStatus.DEPLOYED ||
        d.status === DeploymentStatus.MONITORING ||
        d.status === DeploymentStatus.SETTLED,
    );
    const rolledBack = allDeployments.filter((d) => d.status === DeploymentStatus.ROLLED_BACK);
    const refused = allDeployments.filter((d) => d.status === DeploymentStatus.REFUSED);
    const settled = allDeployments.filter((d) => d.status === DeploymentStatus.SETTLED);

    const attempted = deployed.length + rolledBack.length;

    const timeline = EvolutionDashboardService.buildTimeline(allDeployments);
    const confidenceTrend = EvolutionDashboardService.confidenceTrend(allCandidates);

    const improvements = EvolutionDashboardService.whatImproved({
      deployedCount: deployed.length,
      settledCount: settled.length,
      rolledBackCount: rolledBack.length,
      refusedCount: refused.length,
      betterExperiments: concludedExperiments.filter((e) => e.verdict === 'BETTER').length,
      rejectedCandidates: byStatus(CandidateStatus.REJECTED),
      deployments: deployed,
      activeStrategy: activeStrategy?.name ?? null,
    });

    return {
      generatedAt: to.toISOString(),
      window: { from: from.toISOString(), to: to.toISOString(), days },
      headline: EvolutionDashboardService.headline({
        deployed: deployed.length,
        rolledBack: rolledBack.length,
        refused: refused.length,
        experiments: concludedExperiments.length,
        days,
      }),
      improvements,

      candidates: {
        total: allCandidates.length,
        queued: byStatus(CandidateStatus.QUEUED) + byStatus(CandidateStatus.DRAFT),
        testing: byStatus(CandidateStatus.TESTING),
        validated: byStatus(CandidateStatus.VALIDATED),
        deployed: byStatus(CandidateStatus.DEPLOYED),
        rejected: byStatus(CandidateStatus.REJECTED),
      },

      experiments: {
        active: runningExperiments.map((e) => ({
          id: e.id,
          name: e.name,
          mode: e.mode,
          exposure: EvolutionDashboardService.exposureLabel(e.mode),
          controlTrials: e.controlTrials,
          variantTrials: e.variantTrials,
        })),
        concluded: concludedExperiments.length,
        better: concludedExperiments.filter((e) => e.verdict === 'BETTER').length,
        worse: concludedExperiments.filter((e) => e.verdict === 'WORSE').length,
        inconclusive: concludedExperiments.filter((e) => e.verdict === 'INCONCLUSIVE').length,
      },

      deployments: {
        total: allDeployments.length,
        succeeded: deployed.length,
        rolledBack: rolledBack.length,
        refused: refused.length,
        monitoring: allDeployments.filter((d) => d.status === DeploymentStatus.MONITORING).length,
        successRate: attempted > 0 ? Number((deployed.length / attempted).toFixed(4)) : 0,
      },

      rollbacks: rolledBack.slice(0, 20).map((d) => ({
        id: d.id,
        subjectLabel: d.subjectLabel || d.subjectId,
        kind: d.kind,
        reason: d.rollbackReason,
        automatic: d.automatic,
        at: d.rolledBackAt?.toISOString() ?? null,
      })),

      timeline,

      bestVersions: activeVersions.slice(0, 20).map((v) => ({
        subject: v.subject,
        subjectId: v.subjectId,
        aspect: v.aspect,
        version: v.version,
        label: v.label,
        activatedAt: v.activatedAt?.toISOString() ?? null,
      })),

      planning: {
        active: activeStrategy ? `${activeStrategy.name} v${activeStrategy.version}` : null,
        missionsPlanned: activeStrategy?.missionsPlanned ?? 0,
        successRate: activeStrategy?.successRate ?? 0,
        strategies: strategies.length,
      },

      constitution: {
        version: Constitution.CONSTITUTION_VERSION,
        laws: Constitution.CONSTITUTION.length,
        violations: violations.length,
        byLaw,
      },

      policy: {
        enabled: policy.enabled,
        allowedKinds: policy.allowedKinds,
        autoApproveThreshold: policy.autoApproveThreshold,
        requiresApprovalFor: policy.requireApproval,
      },

      confidenceTrend,
    };
  }

  // ----------------------------------------------------------------
  // Pure composition
  // ----------------------------------------------------------------

  static headline(input: {
    deployed: number;
    rolledBack: number;
    refused: number;
    experiments: number;
    days: number;
  }): string {
    if (input.deployed === 0 && input.experiments === 0) {
      return `No evolution activity in the last ${input.days} days.`;
    }

    const parts = [`${input.experiments} experiment(s) concluded`];
    if (input.deployed > 0) parts.push(`${input.deployed} change(s) deployed`);
    if (input.rolledBack > 0) parts.push(`${input.rolledBack} rolled back`);
    if (input.refused > 0) parts.push(`${input.refused} refused`);

    return `${parts.join(', ')} over ${input.days} days.`;
  }

  /**
   * What actually got better.
   *
   * Rejections and refusals count as improvements to report — a candidate
   * killed by measurement is a change that did not make production worse,
   * and a refusal is the Constitution doing its job. Reporting only
   * deployments would make a system that blocks bad changes look idle.
   */
  static whatImproved(input: {
    deployedCount: number;
    settledCount: number;
    rolledBackCount: number;
    refusedCount: number;
    betterExperiments: number;
    rejectedCandidates: number;
    deployments: Array<{ subjectLabel: string; subjectId: string; kind: string }>;
    activeStrategy: string | null;
  }): string[] {
    const improvements: string[] = [];

    for (const deployment of input.deployments.slice(0, 5)) {
      improvements.push(
        `${deployment.subjectLabel || deployment.subjectId}: ${deployment.kind
          .toLowerCase()
          .replace(/_/g, ' ')} deployed after benchmarking.`,
      );
    }

    if (input.settledCount > 0) {
      improvements.push(
        `${input.settledCount} deployment(s) survived their monitoring window.`,
      );
    }

    if (input.rejectedCandidates > 0) {
      improvements.push(
        `${input.rejectedCandidates} proposed change(s) were rejected by measurement before ` +
          'reaching production.',
      );
    }

    if (input.rolledBackCount > 0) {
      improvements.push(
        `${input.rolledBackCount} deployment(s) were rolled back after underperforming.`,
      );
    }

    if (input.refusedCount > 0) {
      improvements.push(
        `${input.refusedCount} deployment(s) were refused by the Constitution or policy.`,
      );
    }

    if (improvements.length === 0) {
      improvements.push(
        input.betterExperiments > 0
          ? 'Experiments found improvements, but none has been deployed yet.'
          : 'Nothing has changed. No experiment has yet found a measurable improvement.',
      );
    }

    return improvements;
  }

  static buildTimeline(
    deployments: Array<{
      subjectLabel: string;
      subjectId: string;
      kind: string;
      status: DeploymentStatus;
      notes: string | null;
      rollbackReason: string | null;
      deployedAt: Date | null;
      rolledBackAt: Date | null;
      createdAt: Date;
    }>,
  ): EvolutionDigest['timeline'] {
    const entries: EvolutionDigest['timeline'] = [];

    for (const deployment of deployments) {
      const label = deployment.subjectLabel || deployment.subjectId;

      if (deployment.status === DeploymentStatus.REFUSED) {
        entries.push({
          at: deployment.createdAt.toISOString(),
          event: 'refused',
          subjectLabel: label,
          kind: deployment.kind,
          detail: deployment.notes ?? 'refused',
        });
        continue;
      }

      if (deployment.deployedAt) {
        entries.push({
          at: deployment.deployedAt.toISOString(),
          event: 'deployed',
          subjectLabel: label,
          kind: deployment.kind,
          detail: 'deployed after benchmarking',
        });
      }

      if (deployment.rolledBackAt) {
        entries.push({
          at: deployment.rolledBackAt.toISOString(),
          event: 'rolled_back',
          subjectLabel: label,
          kind: deployment.kind,
          detail: deployment.rollbackReason ?? 'rolled back',
        });
      }
    }

    return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  }

  /**
   * Whether the evidence behind proposed changes is getting stronger.
   *
   * A system that is learning should propose better-supported changes over
   * time. Reported as `unknown` below a usable sample, because a trend drawn
   * from three candidates is not a trend.
   */
  static confidenceTrend(
    candidates: Array<{ confidence: number; createdAt: Date }>,
  ): EvolutionDigest['confidenceTrend'] {
    if (candidates.length < 4) {
      return {
        direction: 'unknown',
        average:
          candidates.length > 0
            ? Number(
                (candidates.reduce((s, c) => s + c.confidence, 0) / candidates.length).toFixed(4),
              )
            : 0,
        summary: `Only ${candidates.length} candidate(s) — too few to read a trend.`,
      };
    }

    const ordered = [...candidates].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const half = Math.floor(ordered.length / 2);
    const mean = (rows: typeof ordered) =>
      rows.reduce((s, c) => s + c.confidence, 0) / Math.max(1, rows.length);

    const earlier = mean(ordered.slice(0, half));
    const later = mean(ordered.slice(half));
    const change = later - earlier;
    const average = Number(mean(ordered).toFixed(4));

    const direction =
      Math.abs(change) < 0.05 ? 'steady' : change > 0 ? 'improving' : 'declining';

    return {
      direction,
      average,
      summary:
        `Candidate confidence is ${direction} — ${(earlier * 100).toFixed(0)}% to ` +
        `${(later * 100).toFixed(0)}% across ${ordered.length} candidates ` +
        `(${Confidence.bandFor(average).toLowerCase()} on average).`,
    };
  }

  static exposureLabel(mode: string): string {
    switch (mode) {
      case 'SANDBOX':
        return 'touches nothing real';
      case 'SHADOW':
        return 'observed alongside production';
      case 'CANARY':
        return 'a small share of real work';
      default:
        return 'an even split of real work';
    }
  }
}
