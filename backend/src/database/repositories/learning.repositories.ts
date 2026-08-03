import { Injectable } from '@nestjs/common';
import type {
  DetectedPattern,
  Experiment,
  KnowledgeAudit,
  LearningEntry,
  MissionReview,
  PerformanceSnapshot,
  Recommendation,
  WorkerProfile,
} from '@prisma/client';
import { BaseRepository } from './base.repository';
import { PrismaService } from '../prisma.service';

/**
 * Phase 5 repositories.
 *
 * Each declares a constructor that only calls super() — TypeScript emits the
 * `design:paramtypes` metadata Nest needs for injection only when a class
 * declares one.
 *
 * Several models here have a natural key rather than only an id (one review
 * per mission, one profile per worker, one snapshot per subject-period), so
 * upsert helpers live in the repository rather than being reimplemented as
 * find-then-branch in each service.
 */

@Injectable()
export class MissionReviewRepository extends BaseRepository<MissionReview> {
  protected readonly modelName = 'missionReview';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findForMission(missionId: string): Promise<MissionReview | null> {
    return this.delegate().findFirst({ where: this.scope({ missionId }) });
  }

  recent(take = 50): Promise<MissionReview[]> {
    return this.findMany({}, { take, orderBy: { createdAt: 'desc' } });
  }

  since(from: Date, take = 500): Promise<MissionReview[]> {
    return this.findMany({ createdAt: { gte: from } }, { take, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Keyword search over objective, summary and tags.
   *
   * Tokenised rather than matched whole, so "slow crm sync" finds a review
   * about a CRM sync that was slow — the same lesson learned in Phase 2's
   * knowledge search, applied here rather than rediscovered.
   */
  search(query: string, take = 25): Promise<MissionReview[]> {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2)
      .slice(0, 8);

    if (tokens.length === 0) return this.recent(take);

    return this.findMany(
      {
        OR: tokens.flatMap((token) => [
          { objective: { contains: token, mode: 'insensitive' } },
          { summary: { contains: token, mode: 'insensitive' } },
          { tags: { has: token } },
        ]),
      },
      { take, orderBy: { createdAt: 'desc' } },
    );
  }
}

@Injectable()
export class PerformanceSnapshotRepository extends BaseRepository<PerformanceSnapshot> {
  protected readonly modelName = 'performanceSnapshot';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Writes a period's metrics, replacing any earlier computation of the same
   * window. Recomputing a period must converge rather than accumulate — a
   * rollup run twice should say the same thing, not double it.
   */
  async record(input: {
    subject: PerformanceSnapshot['subject'];
    subjectId: string;
    subjectLabel: string;
    period: PerformanceSnapshot['period'];
    periodStart: Date;
    metrics: Record<string, unknown>;
  }): Promise<PerformanceSnapshot> {
    const organizationId = this.organizationId;
    return this.prisma.performanceSnapshot.upsert({
      where: {
        organizationId_subject_subjectId_period_periodStart: {
          organizationId,
          subject: input.subject,
          subjectId: input.subjectId,
          period: input.period,
          periodStart: input.periodStart,
        },
      },
      create: {
        organizationId,
        subject: input.subject,
        subjectId: input.subjectId,
        subjectLabel: input.subjectLabel,
        period: input.period,
        periodStart: input.periodStart,
        ...(input.metrics as object),
      },
      update: { subjectLabel: input.subjectLabel, ...(input.metrics as object) },
    });
  }

  series(
    subject: PerformanceSnapshot['subject'],
    subjectId: string,
    period: PerformanceSnapshot['period'],
    take = 60,
  ): Promise<PerformanceSnapshot[]> {
    return this.findMany(
      { subject, subjectId, period },
      { take, orderBy: { periodStart: 'desc' } },
    );
  }

  latestFor(
    subject: PerformanceSnapshot['subject'],
    period: PerformanceSnapshot['period'],
    take = 100,
  ): Promise<PerformanceSnapshot[]> {
    return this.findMany({ subject, period }, { take, orderBy: { periodStart: 'desc' } });
  }
}

@Injectable()
export class RecommendationRepository extends BaseRepository<Recommendation> {
  protected readonly modelName = 'recommendation';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** Open proposals, most worth reading first. */
  open(take = 50): Promise<Recommendation[]> {
    return this.findMany(
      { status: { in: ['PROPOSED', 'ACCEPTED'] } },
      { take, orderBy: { priority: 'desc' } },
    );
  }

  forSubject(
    subject: Recommendation['subject'],
    subjectId: string,
  ): Promise<Recommendation[]> {
    return this.findMany({ subject, subjectId }, { orderBy: { createdAt: 'desc' } });
  }

  /** An existing open proposal of the same kind about the same thing. */
  findOpenLike(
    kind: Recommendation['kind'],
    subjectId: string,
  ): Promise<Recommendation | null> {
    return this.delegate().findFirst({
      where: this.scope({ kind, subjectId, status: 'PROPOSED' }),
    });
  }

  applied(take = 50): Promise<Recommendation[]> {
    return this.findMany(
      { status: { in: ['APPLIED', 'ROLLED_BACK'] } },
      { take, orderBy: { appliedAt: 'desc' } },
    );
  }
}

@Injectable()
export class WorkerProfileRepository extends BaseRepository<WorkerProfile> {
  protected readonly modelName = 'workerProfile';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findForWorker(workerId: string): Promise<WorkerProfile | null> {
    return this.delegate().findFirst({ where: this.scope({ workerId }) });
  }

  async upsertForWorker(
    workerId: string,
    data: Record<string, unknown>,
  ): Promise<WorkerProfile> {
    const organizationId = this.organizationId;
    return this.prisma.workerProfile.upsert({
      where: { workerId },
      create: { organizationId, workerId, ...(data as object) },
      update: data as object,
    });
  }

  ranked(take = 50): Promise<WorkerProfile[]> {
    return this.findMany({}, { take, orderBy: { successRate: 'desc' } });
  }
}

@Injectable()
export class DetectedPatternRepository extends BaseRepository<DetectedPattern> {
  protected readonly modelName = 'detectedPattern';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Reinforces an existing pattern or records a new one.
   *
   * Keyed on signature so a regularity seen fifty times is one row with an
   * occurrence count, not fifty rows that each look like a separate
   * discovery — which is the difference between "we have noticed this
   * repeatedly" and "we have noticed fifty things".
   */
  async observe(input: {
    signature: string;
    kind: DetectedPattern['kind'];
    statement: string;
    detail: Record<string, unknown>;
    evidenceIds: string[];
    occurrences: number;
    contradictions: number;
    confidence: number;
    band: string;
  }): Promise<DetectedPattern> {
    const organizationId = this.organizationId;
    return this.prisma.detectedPattern.upsert({
      where: {
        organizationId_signature: { organizationId, signature: input.signature },
      },
      create: {
        organizationId,
        signature: input.signature,
        kind: input.kind,
        statement: input.statement,
        detail: input.detail as never,
        evidenceIds: input.evidenceIds,
        occurrences: input.occurrences,
        contradictions: input.contradictions,
        confidence: input.confidence,
        band: input.band,
      },
      update: {
        statement: input.statement,
        detail: input.detail as never,
        // Capped so a long-lived pattern's evidence list stays a sample
        // rather than growing into every id the system has ever seen.
        evidenceIds: input.evidenceIds.slice(0, 50),
        occurrences: input.occurrences,
        contradictions: input.contradictions,
        confidence: input.confidence,
        band: input.band,
        lastObservedAt: new Date(),
      },
    });
  }

  active(take = 50): Promise<DetectedPattern[]> {
    return this.findMany({ dismissedAt: null }, { take, orderBy: { confidence: 'desc' } });
  }
}

@Injectable()
export class LearningEntryRepository extends BaseRepository<LearningEntry> {
  protected readonly modelName = 'learningEntry';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  ofKind(kind: LearningEntry['kind'], take = 50): Promise<LearningEntry[]> {
    return this.findMany({ kind }, { take, orderBy: { createdAt: 'desc' } });
  }

  current(take = 100): Promise<LearningEntry[]> {
    return this.findMany({ supersededAt: null }, { take, orderBy: { createdAt: 'desc' } });
  }

  since(from: Date, take = 200): Promise<LearningEntry[]> {
    return this.findMany({ createdAt: { gte: from } }, { take, orderBy: { createdAt: 'desc' } });
  }

  findBySource(sourceType: string, sourceId: string): Promise<LearningEntry | null> {
    return this.delegate().findFirst({ where: this.scope({ sourceType, sourceId }) });
  }
}

@Injectable()
export class KnowledgeAuditRepository extends BaseRepository<KnowledgeAudit> {
  protected readonly modelName = 'knowledgeAudit';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  unresolved(take = 100): Promise<KnowledgeAudit[]> {
    return this.findMany({ resolvedAt: null }, { take, orderBy: { confidence: 'desc' } });
  }

  forDocument(knowledgeId: string): Promise<KnowledgeAudit[]> {
    return this.findMany({ knowledgeId }, { orderBy: { createdAt: 'desc' } });
  }

  /** Clears prior unresolved findings so a re-audit converges. */
  async clearUnresolved(): Promise<number> {
    const { count } = await this.delegate().deleteMany({
      where: this.scope({ resolvedAt: null }),
    });
    return count;
  }
}

@Injectable()
export class ExperimentRepository extends BaseRepository<Experiment> {
  protected readonly modelName = 'experiment';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  running(): Promise<Experiment[]> {
    return this.findMany({ status: 'RUNNING' }, { orderBy: { startedAt: 'desc' } });
  }

  findRunningForWorkflow(workflowId: string): Promise<Experiment | null> {
    return this.delegate().findFirst({
      where: this.scope({ workflowId, status: 'RUNNING' }),
    });
  }

  /**
   * Records one run against an arm, as relative increments inside the
   * database rather than a read-modify-write, so two runs finishing at once
   * cannot both read the same "before" value and lose a count.
   */
  async recordRun(
    id: string,
    arm: 'control' | 'variant',
    result: { succeeded: boolean; durationMs: number; costUsd: number },
  ): Promise<void> {
    const prefix = arm;
    await this.prisma.experiment.updateMany({
      where: { id, organizationId: this.organizationId },
      data: {
        [`${prefix}Runs`]: { increment: 1 },
        [`${prefix}Successes`]: { increment: result.succeeded ? 1 : 0 },
        [`${prefix}DurationMs`]: { increment: result.durationMs },
        [`${prefix}CostUsd`]: { increment: result.costUsd },
      } as never,
    });
  }
}

export const LEARNING_REPOSITORIES = [
  MissionReviewRepository,
  PerformanceSnapshotRepository,
  RecommendationRepository,
  WorkerProfileRepository,
  DetectedPatternRepository,
  LearningEntryRepository,
  KnowledgeAuditRepository,
  ExperimentRepository,
];
