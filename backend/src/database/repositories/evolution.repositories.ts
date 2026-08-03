import { Injectable } from '@nestjs/common';
import type {
  Benchmark,
  ConstitutionViolation,
  Deployment,
  EntityVersion,
  EvolutionCandidate,
  EvolutionExperiment,
  EvolutionPolicy,
  PlanningStrategy,
} from '@prisma/client';
import { BaseRepository } from './base.repository';
import { PrismaService } from '../prisma.service';

/**
 * Phase 6 repositories.
 *
 * Each declares a constructor that only calls super() — TypeScript emits the
 * `design:paramtypes` metadata Nest needs for injection only when a class
 * declares one.
 *
 * Two things are deliberately absent. There is no `delete` helper anywhere in
 * this file beyond what BaseRepository already provides, because the
 * NO_AUTOMATIC_DELETION law makes destroying evolution history a thing the
 * system must not be able to do casually. And there is no repository for the
 * Constitution, because it is not data.
 */

@Injectable()
export class EvolutionCandidateRepository extends BaseRepository<EvolutionCandidate> {
  protected readonly modelName = 'evolutionCandidate';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** An open candidate proposing the same change to the same thing. */
  findOpenLike(
    kind: EvolutionCandidate['kind'],
    subjectId: string,
  ): Promise<EvolutionCandidate | null> {
    return this.delegate().findFirst({
      where: this.scope({
        kind,
        subjectId,
        status: { in: ['DRAFT', 'QUEUED', 'TESTING', 'VALIDATED'] },
      }),
      orderBy: { createdAt: 'desc' },
    });
  }

  queue(take = 50): Promise<EvolutionCandidate[]> {
    return this.findMany(
      { status: { in: ['DRAFT', 'QUEUED'] } },
      { take, orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }] as never },
    );
  }

  byStatus(status: EvolutionCandidate['status'], take = 100): Promise<EvolutionCandidate[]> {
    return this.findMany({ status }, { take, orderBy: { updatedAt: 'desc' } });
  }
}

@Injectable()
export class EvolutionExperimentRepository extends BaseRepository<EvolutionExperiment> {
  protected readonly modelName = 'evolutionExperiment';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  running(): Promise<EvolutionExperiment[]> {
    return this.findMany({ status: 'RUNNING' }, { orderBy: { startedAt: 'desc' } });
  }

  countRunning(): Promise<number> {
    return this.count({ status: 'RUNNING' });
  }

  findRunningForCandidate(candidateId: string): Promise<EvolutionExperiment | null> {
    return this.delegate().findFirst({
      where: this.scope({ candidateId, status: 'RUNNING' }),
    });
  }

  forCandidate(candidateId: string): Promise<EvolutionExperiment[]> {
    return this.findMany({ candidateId }, { orderBy: { startedAt: 'desc' } });
  }

  /**
   * Counts a trial against one arm as a relative increment inside the
   * database, so two trials landing at once cannot both read the same
   * "before" value and lose a count.
   */
  async recordTrial(id: string, arm: 'control' | 'variant'): Promise<void> {
    await this.prisma.evolutionExperiment.updateMany({
      where: { id, organizationId: this.organizationId },
      data: { [`${arm}Trials`]: { increment: 1 } } as never,
    });
  }
}

@Injectable()
export class BenchmarkRepository extends BaseRepository<Benchmark> {
  protected readonly modelName = 'benchmark';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  forExperiment(experimentId: string): Promise<Benchmark[]> {
    return this.findMany({ experimentId }, { orderBy: { arm: 'asc' } });
  }

  /**
   * Writes an arm's measurements, replacing any earlier computation.
   *
   * Recomputing a benchmark must converge rather than accumulate: the same
   * trials measured twice should say the same thing, not twice as much.
   */
  async record(
    experimentId: string,
    arm: 'control' | 'variant',
    metrics: Record<string, unknown>,
  ): Promise<Benchmark> {
    const organizationId = this.organizationId;
    return this.prisma.benchmark.upsert({
      where: { experimentId_arm: { experimentId, arm } },
      create: { organizationId, experimentId, arm, ...(metrics as object) },
      update: metrics as object,
    });
  }
}

@Injectable()
export class EntityVersionRepository extends BaseRepository<EntityVersion> {
  protected readonly modelName = 'entityVersion';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  lineage(
    subject: EntityVersion['subject'],
    subjectId: string,
    aspect: EntityVersion['aspect'],
  ): Promise<EntityVersion[]> {
    return this.findMany({ subject, subjectId, aspect }, { orderBy: { version: 'desc' } });
  }

  findActive(
    subject: EntityVersion['subject'],
    subjectId: string,
    aspect: EntityVersion['aspect'],
  ): Promise<EntityVersion | null> {
    return this.delegate().findFirst({
      where: this.scope({ subject, subjectId, aspect, isActive: true }),
    });
  }

  async nextVersion(
    subject: EntityVersion['subject'],
    subjectId: string,
    aspect: EntityVersion['aspect'],
  ): Promise<number> {
    const latest = await this.delegate().findFirst({
      where: this.scope({ subject, subjectId, aspect }),
      orderBy: { version: 'desc' },
    });
    return (latest?.version ?? 0) + 1;
  }

  /**
   * Makes one version the active one for its lineage.
   *
   * Done in a transaction because "exactly one active version" is an
   * invariant, and a crash between deactivating the old one and activating
   * the new one would leave a lineage with none — which reads as "this
   * worker has no prompt" rather than as a failed switch.
   */
  async activate(id: string): Promise<EntityVersion> {
    const organizationId = this.organizationId;
    const target = await this.findByIdOrFail(id);

    return this.prisma.$transaction(async (tx) => {
      await tx.entityVersion.updateMany({
        where: {
          organizationId,
          subject: target.subject,
          subjectId: target.subjectId,
          aspect: target.aspect,
          isActive: true,
        },
        data: { isActive: false, supersededAt: new Date() },
      });

      return tx.entityVersion.update({
        where: { id },
        data: { isActive: true, activatedAt: new Date(), supersededAt: null },
      });
    });
  }

  /** Every aspect that has at least one version, for a subject. */
  aspectsFor(
    subject: EntityVersion['subject'],
    subjectId: string,
  ): Promise<EntityVersion[]> {
    return this.findMany({ subject, subjectId }, { orderBy: { createdAt: 'desc' }, take: 200 });
  }
}

@Injectable()
export class DeploymentRepository extends BaseRepository<Deployment> {
  protected readonly modelName = 'deployment';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  history(take = 100): Promise<Deployment[]> {
    return this.findMany({}, { take, orderBy: { createdAt: 'desc' } });
  }

  forSubject(subject: Deployment['subject'], subjectId: string): Promise<Deployment[]> {
    return this.findMany({ subject, subjectId }, { orderBy: { createdAt: 'desc' } });
  }

  byStatus(status: Deployment['status'], take = 100): Promise<Deployment[]> {
    return this.findMany({ status }, { take, orderBy: { createdAt: 'desc' } });
  }

  /** Deployments still inside their monitoring window. */
  monitoring(): Promise<Deployment[]> {
    return this.findMany(
      { status: 'MONITORING' },
      { orderBy: { deployedAt: 'asc' }, take: 200 },
    );
  }

  /**
   * Deployments whose monitoring window has closed, across all tenants.
   * The sweep that settles or rolls them back has no ambient organization.
   */
  findSettleableUnscoped(now = new Date()): Promise<Deployment[]> {
    return this.prisma.deployment.findMany({
      where: { status: 'MONITORING', monitorUntil: { lt: now } },
      take: 200,
    });
  }

  countSince(since: Date): Promise<number> {
    return this.count({ status: { in: ['DEPLOYED', 'MONITORING', 'SETTLED'] }, createdAt: { gte: since } });
  }
}

@Injectable()
export class EvolutionPolicyRepository extends BaseRepository<EvolutionPolicy> {
  protected readonly modelName = 'evolutionPolicy';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  find(): Promise<EvolutionPolicy | null> {
    return this.delegate().findFirst({ where: this.scope({}) });
  }

  async upsert(data: Record<string, unknown>): Promise<EvolutionPolicy> {
    const organizationId = this.organizationId;
    return this.prisma.evolutionPolicy.upsert({
      where: { organizationId },
      create: { organizationId, ...(data as object) },
      update: data as object,
    });
  }
}

@Injectable()
export class ConstitutionViolationRepository extends BaseRepository<ConstitutionViolation> {
  protected readonly modelName = 'constitutionViolation';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  recent(take = 100): Promise<ConstitutionViolation[]> {
    return this.findMany({}, { take, orderBy: { createdAt: 'desc' } });
  }

  /** How often each law has refused something, newest window first. */
  async countByLaw(since: Date): Promise<Array<{ lawId: string; count: number }>> {
    const rows = await this.prisma.constitutionViolation.groupBy({
      by: ['lawId'],
      where: { organizationId: this.organizationId, createdAt: { gte: since } },
      _count: { _all: true },
    });
    return rows
      .map((row) => ({ lawId: row.lawId, count: (row._count as { _all: number })._all }))
      .sort((a, b) => b.count - a.count);
  }
}

@Injectable()
export class PlanningStrategyRepository extends BaseRepository<PlanningStrategy> {
  protected readonly modelName = 'planningStrategy';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findActive(): Promise<PlanningStrategy | null> {
    return this.delegate().findFirst({ where: this.scope({ isActive: true }) });
  }

  lineage(name: string): Promise<PlanningStrategy[]> {
    return this.findMany({ name }, { orderBy: { version: 'desc' } });
  }

  async nextVersion(name: string): Promise<number> {
    const latest = await this.delegate().findFirst({
      where: this.scope({ name }),
      orderBy: { version: 'desc' },
    });
    return (latest?.version ?? 0) + 1;
  }

  /** Same invariant as entity versions: exactly one active strategy. */
  async activate(id: string): Promise<PlanningStrategy> {
    const organizationId = this.organizationId;
    return this.prisma.$transaction(async (tx) => {
      await tx.planningStrategy.updateMany({
        where: { organizationId, isActive: true },
        data: { isActive: false },
      });
      return tx.planningStrategy.update({
        where: { id },
        data: { isActive: true, activatedAt: new Date() },
      });
    });
  }

  ranked(take = 25): Promise<PlanningStrategy[]> {
    return this.findMany({}, { take, orderBy: { successRate: 'desc' } });
  }
}

export const EVOLUTION_REPOSITORIES = [
  EvolutionCandidateRepository,
  EvolutionExperimentRepository,
  BenchmarkRepository,
  EntityVersionRepository,
  DeploymentRepository,
  EvolutionPolicyRepository,
  ConstitutionViolationRepository,
  PlanningStrategyRepository,
];
