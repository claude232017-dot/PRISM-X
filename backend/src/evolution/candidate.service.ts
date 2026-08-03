import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CandidateStatus,
  EvolutionCandidate,
  EvolutionKind,
  EvolutionSubject,
  Recommendation,
  RecommendationKind,
  RiskLevel,
} from '@prisma/client';
import { EvolutionCandidateRepository } from '../database/repositories/evolution.repositories';
import { RecommendationRepository } from '../database/repositories/learning.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import * as Confidence from '../learning/confidence';

export interface CreateCandidateInput {
  kind: EvolutionKind;
  subject: EvolutionSubject;
  subjectId: string;
  subjectLabel?: string;
  description: string;
  reason: string;
  expectedBenefit: string;
  proposedChange: Record<string, unknown>;
  rollback: Record<string, unknown>;
  confidence: number;
  sampleSize?: number;
  risk?: RiskLevel;
  sourceRecommendationId?: string;
}

/**
 * Where evolution begins.
 *
 * A candidate is a concrete, testable change — distinct from a Phase 5
 * recommendation, which is advice for a person. The distinction is what lets
 * the two behave differently: a recommendation waits to be read, while a
 * candidate goes into an experiment and can be rejected by measurement
 * without anyone having to look at it. Most candidates should die that way.
 *
 * Candidates are generated automatically from recommendations that recur.
 * Recurrence matters more than a single high-confidence proposal: the
 * learning engine re-runs, and an opportunity that shows up again after new
 * evidence has arrived is one the system keeps finding rather than one it
 * found once.
 */
@Injectable()
export class CandidateService implements OnModuleInit {
  private readonly logger = new Logger(CandidateService.name);

  /**
   * Recommendation kinds that map onto an evolvable change, and what they
   * become. Anything not listed here stays advice — a knowledge merge or a
   * capacity note has no automatic form.
   */
  static readonly KIND_MAP: Partial<Record<RecommendationKind, EvolutionKind>> = {
    PROVIDER_SWITCH: EvolutionKind.PROVIDER_CHANGE,
    MODEL_SWITCH: EvolutionKind.MODEL_CHANGE,
    PROMPT_REFINEMENT: EvolutionKind.PROMPT_OPTIMIZATION,
    TOOL_PERMISSION: EvolutionKind.TOOL_PERMISSION,
    MEMORY_TUNING: EvolutionKind.MEMORY_STRATEGY,
    LIMIT_ADJUSTMENT: EvolutionKind.EXECUTION_LIMITS,
    WORKFLOW_STRUCTURE: EvolutionKind.WORKFLOW_STRUCTURE,
    WORKFLOW_PARALLELISE: EvolutionKind.WORKFLOW_PARALLELISM,
    WORKFLOW_PRUNE: EvolutionKind.WORKFLOW_SIMPLIFICATION,
  };

  static readonly SUBJECT_MAP: Record<string, EvolutionSubject> = {
    WORKER: EvolutionSubject.WORKER,
    WORKFLOW: EvolutionSubject.WORKFLOW,
    PROVIDER: EvolutionSubject.PROVIDER,
    ORGANIZATION: EvolutionSubject.ORGANIZATION,
    MISSION: EvolutionSubject.ORGANIZATION,
  };

  /** Confidence a recommendation needs before it is worth testing. */
  static readonly MIN_CONFIDENCE = 0.4;

  constructor(
    private readonly candidates: EvolutionCandidateRepository,
    private readonly recommendations: RecommendationRepository,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void {
    // A recommendation being proposed is the moment to consider promoting
    // it, so promotion is driven by the event rather than by a sweep that
    // has to guess how often to run.
    this.events.on(DomainEvent.RecommendationProposed, async (event) => {
      const id = (event.payload as { recommendationId?: string }).recommendationId;
      if (!id) return;
      try {
        await this.asOrganization(event.organizationId, () => this.promote(id));
      } catch (error) {
        // Failing to promote costs a candidate, which the sweep will find
        // later. It must not fail the recommendation that triggered it.
        this.logger.warn(`Could not promote recommendation ${id}: ${(error as Error).message}`);
      }
    });
  }

  // ----------------------------------------------------------------
  // Generation
  // ----------------------------------------------------------------

  /**
   * Turns one recommendation into a candidate, if it qualifies.
   *
   * Returns null rather than throwing for the ordinary cases — advisory
   * kinds, thin evidence, no rollback — because most recommendations
   * legitimately never become candidates and an exception per skip would
   * bury the real failures.
   */
  async promote(recommendationId: string): Promise<EvolutionCandidate | null> {
    const recommendation = await this.recommendations.findById(recommendationId);
    if (!recommendation) return null;

    const kind = CandidateService.KIND_MAP[recommendation.kind];
    if (!kind) return null;

    if (recommendation.confidence < CandidateService.MIN_CONFIDENCE) return null;

    const change = recommendation.proposedChange as Record<string, unknown>;
    const rollback = recommendation.rollback as Record<string, unknown>;

    // A workflow-structure recommendation deliberately carries no concrete
    // change — Phase 5 describes the problem and leaves the rewrite to a
    // human. There is nothing to test, so there is nothing to promote.
    if (Object.keys(change).length === 0) return null;
    if (Object.keys(rollback).length === 0) return null;

    const subject = CandidateService.SUBJECT_MAP[recommendation.subject] ?? EvolutionSubject.WORKER;

    return this.create({
      kind,
      subject,
      subjectId: recommendation.subjectId,
      subjectLabel: recommendation.subjectLabel,
      description: recommendation.title,
      reason: recommendation.reasoning,
      expectedBenefit: recommendation.impactSummary,
      proposedChange: change,
      rollback,
      confidence: recommendation.confidence,
      sampleSize: recommendation.sampleSize,
      risk: recommendation.risk,
      sourceRecommendationId: recommendation.id,
    });
  }

  /**
   * Sweeps open recommendations for anything that has not been promoted.
   *
   * The event hook covers the normal path; this covers recommendations that
   * predate Phase 6 and any the hook missed while something was down.
   */
  async generate(): Promise<{ scanned: number; created: number; skipped: number }> {
    const open = await this.recommendations.open(200);
    let created = 0;

    for (const recommendation of open) {
      const candidate = await this.promote(recommendation.id);
      if (candidate) created += 1;
    }

    return { scanned: open.length, created, skipped: open.length - created };
  }

  /**
   * Records a candidate, or reinforces the existing one.
   *
   * The same change proposed twice is not two candidates — it is one
   * candidate with better evidence. `proposalCount` makes that recurrence
   * visible, which is a genuine signal: an opportunity the learning engine
   * keeps rediscovering after new data has arrived is more real than one it
   * found once.
   */
  async create(input: CreateCandidateInput): Promise<EvolutionCandidate> {
    if (Object.keys(input.rollback).length === 0) {
      throw new BadRequestException(
        'A candidate must carry the state needed to undo it. ' +
          'The Constitution refuses irreversible deployments, so an irreversible ' +
          'candidate could never be deployed anyway.',
      );
    }
    if (Object.keys(input.proposedChange).length === 0) {
      throw new BadRequestException('A candidate must propose an actual change');
    }

    const existing = await this.candidates.findOpenLike(input.kind, input.subjectId);

    if (existing) {
      // Reinforce rather than duplicate. Confidence takes the higher of the
      // two: the newer analysis saw more data, but a re-proposal that
      // happens to be less certain should not erase what was already known.
      const updated = await this.candidates.update(existing.id, {
        proposalCount: existing.proposalCount + 1,
        confidence: Math.max(existing.confidence, input.confidence),
        sampleSize: Math.max(existing.sampleSize, input.sampleSize ?? 0),
        reason: input.reason,
        expectedBenefit: input.expectedBenefit,
        proposedChange: input.proposedChange as never,
        rollback: input.rollback as never,
      });
      return updated;
    }

    const candidate = await this.candidates.create({
      kind: input.kind,
      subject: input.subject,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel ?? '',
      description: input.description,
      reason: input.reason,
      expectedBenefit: input.expectedBenefit,
      proposedChange: input.proposedChange as never,
      rollback: input.rollback as never,
      confidence: Number(input.confidence.toFixed(4)),
      sampleSize: input.sampleSize ?? 0,
      risk: input.risk ?? CandidateService.riskFor(input.kind, input.confidence),
      status: CandidateStatus.DRAFT,
      sourceRecommendationId: input.sourceRecommendationId ?? null,
    });

    await this.events.publish(DomainEvent.EvolutionCandidateCreated, {
      candidateId: candidate.id,
      kind: candidate.kind,
      subjectId: candidate.subjectId,
      confidence: candidate.confidence,
      risk: candidate.risk,
    });

    return candidate;
  }

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  async list(status?: CandidateStatus, take = 50): Promise<EvolutionCandidate[]> {
    if (status) return this.candidates.byStatus(status, take);
    return this.candidates.findMany({}, { take, orderBy: { createdAt: 'desc' } });
  }

  async queue(take = 50): Promise<EvolutionCandidate[]> {
    return this.candidates.queue(take);
  }

  async get(id: string): Promise<EvolutionCandidate> {
    return this.candidates.findByIdOrFail(id);
  }

  async setStatus(
    id: string,
    status: CandidateStatus,
    extra: Record<string, unknown> = {},
  ): Promise<EvolutionCandidate> {
    return this.candidates.update(id, { status, ...extra });
  }

  async queueForTesting(id: string): Promise<EvolutionCandidate> {
    const candidate = await this.candidates.findByIdOrFail(id);
    if (candidate.status !== CandidateStatus.DRAFT && candidate.status !== CandidateStatus.QUEUED) {
      throw new BadRequestException(
        `That candidate is ${candidate.status.toLowerCase()} and cannot be re-queued`,
      );
    }

    const queued = await this.candidates.update(id, { status: CandidateStatus.QUEUED });
    await this.events.publish(DomainEvent.EvolutionCandidateQueued, { candidateId: id });
    return queued;
  }

  async reject(id: string, reason: string): Promise<EvolutionCandidate> {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('Rejecting a candidate requires a reason');
    }

    const rejected = await this.candidates.update(id, {
      status: CandidateStatus.REJECTED,
      rejectedReason: reason,
    });

    await this.events.publish(DomainEvent.EvolutionCandidateRejected, {
      candidateId: id,
      reason,
    });

    return rejected;
  }

  // ----------------------------------------------------------------
  // Pure helpers
  // ----------------------------------------------------------------

  /**
   * Default risk for a change nobody has classified.
   *
   * Structural changes and permission grants are inherently riskier than a
   * limit tweak, and low confidence raises the floor on everything — a
   * change we are unsure about is by definition riskier than the same change
   * we are sure about.
   */
  static riskFor(kind: EvolutionKind, confidence: number): RiskLevel {
    const structural =
      kind === EvolutionKind.WORKFLOW_STRUCTURE ||
      kind === EvolutionKind.WORKFLOW_SIMPLIFICATION ||
      kind === EvolutionKind.MISSION_TEMPLATE;

    if (kind === EvolutionKind.TOOL_PERMISSION) return RiskLevel.HIGH;
    if (structural) return confidence >= 0.85 ? RiskLevel.MEDIUM : RiskLevel.HIGH;
    if (kind === EvolutionKind.PROVIDER_CHANGE || kind === EvolutionKind.PLANNING_STRATEGY) {
      return RiskLevel.MEDIUM;
    }
    if (confidence < Confidence.BAND_THRESHOLDS[2].min) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }

  private asOrganization<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return RequestContextStore.run(
      {
        userId: 'system',
        organizationId,
        roleKey: 'SYSTEM',
        permissions: ['*'],
        requestId: `candidate-${Date.now()}`,
      },
      fn,
    );
  }
}
