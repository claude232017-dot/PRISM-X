import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  MetricSubject,
  Recommendation,
  RecommendationKind,
  RecommendationStatus,
  RiskLevel,
} from '@prisma/client';
import {
  LearningEntryRepository,
  RecommendationRepository,
} from '../database/repositories/learning.repositories';
import {
  OrganizationRepository,
} from '../database/repositories/identity.repositories';
import {
  ProviderRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import { WorkflowRepository } from '../database/repositories/automation.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import * as Confidence from './confidence';

export interface ProposeInput {
  kind: RecommendationKind;
  subject: MetricSubject;
  subjectId: string;
  subjectLabel?: string;
  title: string;
  reasoning: string;
  evidence: Record<string, unknown>;
  estimatedImpact: number;
  impactSummary: string;
  risk?: RiskLevel;
  riskNotes?: string;
  proposedChange: Record<string, unknown>;
  rollback: Record<string, unknown>;
  confidence: number;
  sampleSize: number;
  expiresAt?: Date | null;
}

export interface ApplyResult {
  recommendation: Recommendation;
  applied: boolean;
  changed: Record<string, unknown>;
  message: string;
}

/**
 * Proposals, and the gate they have to pass.
 *
 * A recommendation is inert data. It says what it would change and how to
 * put it back, and until a person accepts it, nothing happens. That is the
 * whole design: a system that can rewrite its own workers and workflows on
 * the strength of its own analysis is one bad inference away from breaking
 * production, and the analysis is exactly the part most likely to be wrong.
 *
 * Two rules keep it honest:
 *
 *  - **Rollback is captured at propose time**, not at apply time. A proposal
 *    that cannot describe how to undo itself is never approvable, which
 *    rules out the class of change nobody can reverse.
 *  - **Priority is impact × confidence.** Ranking on impact alone puts
 *    confident nonsense at the top of the list, which is where a busy
 *    person's attention goes.
 */
@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  /**
   * Organization setting that permits applying without a human. Off unless
   * explicitly turned on, and even then only for low-risk kinds.
   */
  static readonly AUTOPILOT_SETTING = 'learning.autoApply';

  /** Kinds an organization may let through unattended, if it opts in. */
  static readonly AUTOPILOT_ELIGIBLE: RecommendationKind[] = [
    RecommendationKind.MODEL_SWITCH,
    RecommendationKind.PROVIDER_SWITCH,
    RecommendationKind.LIMIT_ADJUSTMENT,
    RecommendationKind.MEMORY_TUNING,
  ];

  /** Confidence below which nothing may be applied unattended, ever. */
  static readonly AUTOPILOT_MIN_CONFIDENCE = 0.85;

  constructor(
    private readonly recommendations: RecommendationRepository,
    private readonly learning: LearningEntryRepository,
    private readonly workers: WorkerRepository,
    private readonly providers: ProviderRepository,
    private readonly workflows: WorkflowRepository,
    private readonly organizations: OrganizationRepository,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Proposing
  // ----------------------------------------------------------------

  /**
   * Records a proposal, replacing any open one about the same thing.
   *
   * Superseding rather than accumulating matters: an analyser that runs
   * nightly would otherwise produce the same suggestion every night, and a
   * list of forty identical proposals is a list nobody reads.
   */
  async propose(input: ProposeInput): Promise<Recommendation> {
    if (Object.keys(input.rollback).length === 0) {
      throw new BadRequestException(
        `A ${input.kind} recommendation must carry a rollback. ` +
          'A change nobody can undo is not something to approve.',
      );
    }

    const priority = Number(
      (Math.min(1, Math.max(0, input.estimatedImpact)) * input.confidence).toFixed(4),
    );

    const existing = await this.recommendations.findOpenLike(input.kind, input.subjectId);

    const payload = {
      kind: input.kind,
      subject: input.subject,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel ?? '',
      title: input.title,
      reasoning: input.reasoning,
      evidence: input.evidence as never,
      estimatedImpact: Number(input.estimatedImpact.toFixed(4)),
      impactSummary: input.impactSummary,
      risk: input.risk ?? RiskLevel.LOW,
      riskNotes: input.riskNotes ?? null,
      proposedChange: input.proposedChange as never,
      rollback: input.rollback as never,
      confidence: Number(input.confidence.toFixed(4)),
      sampleSize: input.sampleSize,
      priority,
      status: RecommendationStatus.PROPOSED,
      expiresAt: input.expiresAt ?? null,
      supersedesId: existing?.id ?? null,
    };

    if (existing) {
      await this.recommendations.update(existing.id, {
        status: RecommendationStatus.EXPIRED,
        decisionNotes: 'Superseded by a newer analysis',
      });
    }

    const recommendation = await this.recommendations.create(payload);

    await this.events.publish(DomainEvent.RecommendationProposed, {
      recommendationId: recommendation.id,
      kind: recommendation.kind,
      subjectId: recommendation.subjectId,
      priority,
      confidence: recommendation.confidence,
    });

    return recommendation;
  }

  async list(status?: RecommendationStatus, take = 50): Promise<Recommendation[]> {
    if (status) {
      return this.recommendations.findMany({ status }, { take, orderBy: { priority: 'desc' } });
    }
    return this.recommendations.open(take);
  }

  async get(id: string): Promise<Recommendation> {
    return this.recommendations.findByIdOrFail(id);
  }

  // ----------------------------------------------------------------
  // The gate
  // ----------------------------------------------------------------

  async accept(id: string, notes?: string): Promise<Recommendation> {
    const ctx = RequestContextStore.require();
    const recommendation = await this.recommendations.findByIdOrFail(id);
    RecommendationService.assertOpen(recommendation);

    const accepted = await this.recommendations.update(id, {
      status: RecommendationStatus.ACCEPTED,
      decidedById: ctx.userId,
      decidedAt: new Date(),
      decisionNotes: notes ?? null,
    });

    await this.events.publish(DomainEvent.RecommendationAccepted, {
      recommendationId: id,
      kind: recommendation.kind,
    });

    return accepted;
  }

  /**
   * Rejects a proposal.
   *
   * The reason is required, and it is not bureaucracy: a rejected
   * recommendation is evidence about the analyser, and "no" without a reason
   * teaches the system nothing. It is written into the learning repository
   * for exactly that purpose.
   */
  async reject(id: string, reason: string): Promise<Recommendation> {
    const ctx = RequestContextStore.require();
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('Rejecting a recommendation requires a reason');
    }

    const recommendation = await this.recommendations.findByIdOrFail(id);
    RecommendationService.assertOpen(recommendation);

    const rejected = await this.recommendations.update(id, {
      status: RecommendationStatus.REJECTED,
      decidedById: ctx.userId,
      decidedAt: new Date(),
      decisionNotes: reason,
    });

    await this.learning.create({
      kind: 'DECISION',
      title: `Rejected: ${recommendation.title}`,
      body: `A human rejected this recommendation. Reason: ${reason}`,
      sourceType: 'recommendation',
      sourceId: id,
      data: {
        kind: recommendation.kind,
        confidence: recommendation.confidence,
        estimatedImpact: recommendation.estimatedImpact,
        reason,
      } as never,
      tags: ['rejected', recommendation.kind.toLowerCase()],
      confidence: recommendation.confidence,
      sampleSize: recommendation.sampleSize,
    });

    await this.events.publish(DomainEvent.RecommendationRejected, {
      recommendationId: id,
      reason,
    });

    return rejected;
  }

  /**
   * Applies an accepted recommendation to production.
   *
   * Refuses anything not explicitly accepted, unless the organization has
   * turned on autopilot *and* the kind is low-risk *and* confidence clears
   * the bar. Those three conditions are separate on purpose — an
   * organization opting into automation has not thereby consented to
   * automatic changes based on three data points.
   */
  async apply(id: string, options: { viaAutopilot?: boolean } = {}): Promise<ApplyResult> {
    const ctx = RequestContextStore.require();
    const recommendation = await this.recommendations.findByIdOrFail(id);

    if (recommendation.status === RecommendationStatus.APPLIED) {
      throw new BadRequestException('That recommendation has already been applied');
    }

    if (recommendation.status !== RecommendationStatus.ACCEPTED) {
      if (!options.viaAutopilot) {
        throw new ForbiddenException(
          'A recommendation must be accepted by a person before it can be applied. ' +
            'PRISM-X does not change production on its own analysis.',
        );
      }
      await this.assertAutopilotAllows(recommendation);
    }

    // The current state is captured immediately before the write, so a
    // rollback restores what was actually there rather than what the
    // proposal assumed was there when it was written.
    const before = await this.captureState(recommendation);
    const changed = await this.writeChange(
      recommendation,
      recommendation.proposedChange as Record<string, unknown>,
    );

    const applied = await this.recommendations.update(id, {
      status: RecommendationStatus.APPLIED,
      appliedAt: new Date(),
      appliedSnapshot: before as never,
      decidedById: recommendation.decidedById ?? ctx.userId,
      decidedAt: recommendation.decidedAt ?? new Date(),
    });

    await this.learning.create({
      kind: 'OPTIMIZATION',
      title: `Applied: ${recommendation.title}`,
      body: `${recommendation.reasoning}\n\nExpected: ${recommendation.impactSummary}`,
      sourceType: 'recommendation',
      sourceId: id,
      data: { before, after: changed, viaAutopilot: Boolean(options.viaAutopilot) } as never,
      tags: ['applied', recommendation.kind.toLowerCase()],
      confidence: recommendation.confidence,
      sampleSize: recommendation.sampleSize,
    });

    await this.events.publish(DomainEvent.RecommendationApplied, {
      recommendationId: id,
      kind: recommendation.kind,
      subjectId: recommendation.subjectId,
      viaAutopilot: Boolean(options.viaAutopilot),
    });

    return {
      recommendation: applied,
      applied: true,
      changed,
      message: `Applied to ${recommendation.subjectLabel || recommendation.subjectId}.`,
    };
  }

  /**
   * Restores the state captured when the recommendation was applied.
   *
   * Uses `appliedSnapshot` — what was actually there — in preference to the
   * `rollback` written at propose time, which is only a fallback for a
   * recommendation applied before snapshots existed.
   */
  async rollback(id: string): Promise<ApplyResult> {
    const recommendation = await this.recommendations.findByIdOrFail(id);

    if (recommendation.status !== RecommendationStatus.APPLIED) {
      throw new BadRequestException('Only an applied recommendation can be rolled back');
    }

    const restore =
      (recommendation.appliedSnapshot as Record<string, unknown> | null) ??
      (recommendation.rollback as Record<string, unknown>);

    const changed = await this.writeChange(recommendation, restore);

    const rolledBack = await this.recommendations.update(id, {
      status: RecommendationStatus.ROLLED_BACK,
      rolledBackAt: new Date(),
    });

    await this.events.publish(DomainEvent.RecommendationRolledBack, {
      recommendationId: id,
      subjectId: recommendation.subjectId,
    });

    return {
      recommendation: rolledBack,
      applied: false,
      changed,
      message: `Rolled back on ${recommendation.subjectLabel || recommendation.subjectId}.`,
    };
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private async assertAutopilotAllows(recommendation: Recommendation): Promise<void> {
    const ctx = RequestContextStore.require();
    const organization = await this.organizations.findById(ctx.organizationId);
    const settings = (organization?.settings ?? {}) as Record<string, unknown>;
    const enabled = settings[RecommendationService.AUTOPILOT_SETTING] === true;

    if (!enabled) {
      throw new ForbiddenException(
        'Automatic application is off for this organization. ' +
          `Enable "${RecommendationService.AUTOPILOT_SETTING}" to allow it, or accept ` +
          'this recommendation manually.',
      );
    }

    if (!RecommendationService.AUTOPILOT_ELIGIBLE.includes(recommendation.kind)) {
      throw new ForbiddenException(
        `${recommendation.kind} always needs a person. Autopilot covers only ` +
          `${RecommendationService.AUTOPILOT_ELIGIBLE.join(', ')}.`,
      );
    }

    if (recommendation.risk !== RiskLevel.LOW) {
      throw new ForbiddenException(
        `This recommendation is rated ${recommendation.risk} risk; autopilot applies only low-risk changes.`,
      );
    }

    if (recommendation.confidence < RecommendationService.AUTOPILOT_MIN_CONFIDENCE) {
      throw new ForbiddenException(
        `Confidence ${(recommendation.confidence * 100).toFixed(0)}% is below the ` +
          `${RecommendationService.AUTOPILOT_MIN_CONFIDENCE * 100}% autopilot threshold ` +
          `(${recommendation.sampleSize} observations).`,
      );
    }
  }

  /** Reads back exactly the fields the change will overwrite. */
  private async captureState(
    recommendation: Recommendation,
  ): Promise<Record<string, unknown>> {
    const fields = Object.keys(recommendation.proposedChange as Record<string, unknown>);
    const state: Record<string, unknown> = {};

    if (recommendation.subject === MetricSubject.WORKER) {
      const worker = await this.workers.findById(recommendation.subjectId);
      if (worker) {
        for (const field of fields) {
          state[field] = (worker as unknown as Record<string, unknown>)[field];
        }
      }
      return state;
    }

    if (recommendation.subject === MetricSubject.WORKFLOW) {
      const workflow = await this.workflows.findById(recommendation.subjectId);
      if (workflow) {
        for (const field of fields) {
          state[field] = (workflow as unknown as Record<string, unknown>)[field];
        }
      }
      return state;
    }

    if (recommendation.subject === MetricSubject.PROVIDER) {
      const provider = await this.providers.findById(recommendation.subjectId);
      if (provider) {
        for (const field of fields) {
          state[field] = (provider as unknown as Record<string, unknown>)[field];
        }
      }
    }

    return state;
  }

  /**
   * The only place a recommendation touches production.
   *
   * Narrow by design: it writes through the ordinary repositories, so tenant
   * scoping and soft-delete filtering apply exactly as they do to a human
   * making the same edit. There is no privileged path.
   */
  private async writeChange(
    recommendation: Recommendation,
    change: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (Object.keys(change).length === 0) return {};

    switch (recommendation.subject) {
      case MetricSubject.WORKER:
        await this.workers.update(recommendation.subjectId, change);
        return change;
      case MetricSubject.WORKFLOW:
        await this.workflows.update(recommendation.subjectId, change);
        return change;
      case MetricSubject.PROVIDER:
        await this.providers.update(recommendation.subjectId, change);
        return change;
      default:
        // Organization- and mission-level recommendations are advisory:
        // there is no single field to set, so applying them means a human
        // acting on the advice. Silently doing nothing while reporting
        // success would be the worse failure.
        throw new BadRequestException(
          `${recommendation.subject} recommendations are advisory and cannot be applied automatically.`,
        );
    }
  }

  private static assertOpen(recommendation: Recommendation): void {
    if (
      recommendation.status !== RecommendationStatus.PROPOSED &&
      recommendation.status !== RecommendationStatus.ACCEPTED
    ) {
      throw new BadRequestException(
        `That recommendation is ${recommendation.status.toLowerCase()} and can no longer be decided.`,
      );
    }
  }

  /**
   * Ranking key: impact weighted by how much the impact estimate is worth.
   *
   * Exposed for testing because it is the judgement that decides what a
   * human sees first, and getting it wrong quietly wastes their attention.
   */
  static priorityOf(estimatedImpact: number, confidence: number): number {
    const impact = Math.min(1, Math.max(0, estimatedImpact));
    return Number((impact * Math.min(1, Math.max(0, confidence))).toFixed(4));
  }

  /** Risk band from what the change touches and how sure the system is. */
  static riskFor(kind: RecommendationKind, confidence: number): RiskLevel {
    const structural =
      kind === RecommendationKind.WORKFLOW_STRUCTURE ||
      kind === RecommendationKind.WORKFLOW_PRUNE ||
      kind === RecommendationKind.KNOWLEDGE_MERGE;

    if (structural) return confidence >= 0.8 ? RiskLevel.MEDIUM : RiskLevel.HIGH;
    if (kind === RecommendationKind.TOOL_PERMISSION) return RiskLevel.MEDIUM;
    if (confidence < Confidence.BAND_THRESHOLDS[2].min) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }
}
