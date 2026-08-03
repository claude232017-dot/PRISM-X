import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  BenchmarkVerdict,
  CandidateStatus,
  Deployment,
  DeploymentStatus,
  EvolutionCandidate,
  EvolutionSubject,
  VersionOrigin,
} from '@prisma/client';
import {
  BenchmarkRepository,
  DeploymentRepository,
  EvolutionCandidateRepository,
  EvolutionExperimentRepository,
  ConstitutionViolationRepository,
} from '../database/repositories/evolution.repositories';
import {
  ProviderRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import { WorkflowRepository } from '../database/repositories/automation.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import * as Constitution from './constitution';
import { EvolutionPolicyService } from './policy.service';
import { VersionService } from './version.service';
import { CandidateService } from './candidate.service';

export interface DeployResult {
  deployment: Deployment;
  deployed: boolean;
  /** Populated when the Constitution or the policy refused. */
  refusal?: { laws: string[]; reasons: string[] };
}

/**
 * The only route from the Evolution Engine to production.
 *
 * Everything upstream — candidates, experiments, benchmarks — is analysis
 * that touches nothing. This is where a change is actually written, and it
 * is deliberately a single narrow method so that the Constitution has one
 * place to stand rather than a set of places it hopes it covered.
 *
 * The order of operations matters and is not negotiable:
 *
 *   1. Read the current state — what the change will overwrite.
 *   2. Ask the policy whether this organization permits it.
 *   3. Submit the intent to the Constitution.
 *   4. Write the deployment row, *before* touching production, so a crash
 *      mid-write leaves evidence rather than a silent divergence.
 *   5. Apply the change.
 *   6. Watch it.
 *
 * A refusal is recorded as a deployment with status REFUSED and a
 * ConstitutionViolation row per law that objected. Refusals are as much a
 * part of the evolutionary record as successes: an engine that keeps
 * proposing illegal changes is telling you something about itself.
 */
@Injectable()
export class DeploymentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeploymentService.name);
  private timer?: NodeJS.Timeout;

  /** How often settled deployments are swept. */
  static readonly SWEEP_INTERVAL_MS = 60_000;

  constructor(
    private readonly deployments: DeploymentRepository,
    private readonly candidates: EvolutionCandidateRepository,
    private readonly experiments: EvolutionExperimentRepository,
    private readonly benchmarks: BenchmarkRepository,
    private readonly violations: ConstitutionViolationRepository,
    private readonly workers: WorkerRepository,
    private readonly workflows: WorkflowRepository,
    private readonly providers: ProviderRepository,
    private readonly policy: EvolutionPolicyService,
    private readonly versions: VersionService,
    private readonly candidateService: CandidateService,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void {
    // Disabled under test so a sweep does not settle a deployment in the
    // middle of an assertion about its monitoring state.
    if (process.env.NODE_ENV === 'test' || process.env.PRISMX_DISABLE_SWEEP === '1') return;

    this.timer = setInterval(() => {
      this.sweep().catch((error) =>
        this.logger.error(`Deployment sweep failed: ${(error as Error).message}`),
      );
    }, DeploymentService.SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ----------------------------------------------------------------
  // Approval
  // ----------------------------------------------------------------

  /**
   * Records a human decision to proceed.
   *
   * Separate from deployment because the two are genuinely different acts:
   * approval says the change is acceptable, deployment says now is the
   * moment. An organization with a deployment window needs to be able to
   * approve at 3pm and deploy at 2am.
   */
  async approve(candidateId: string, notes?: string): Promise<EvolutionCandidate> {
    const ctx = RequestContextStore.require();
    const candidate = await this.candidates.findByIdOrFail(candidateId);

    // Approval requires that the change has been *measured*, not that the
    // measurement was flattering. A validated candidate is the normal case;
    // one whose experiment could not tell the arms apart is also approvable,
    // because inconclusive is not refutation and a person may have a reason
    // the benchmark does not measure. A candidate measured *worse* is not.
    const experiments = await this.experiments.forCandidate(candidateId);
    const concluded = experiments.filter((e) => e.verdict);
    const measuredWorse = concluded.some((e) => e.verdict === 'WORSE');

    if (measuredWorse) {
      throw new BadRequestException(
        'The benchmark found this change performs worse than what it replaces. ' +
          'Re-propose it with different evidence rather than approving past the measurement.',
      );
    }

    if (candidate.status !== CandidateStatus.VALIDATED && concluded.length === 0) {
      throw new BadRequestException(
        `This candidate is ${candidate.status.toLowerCase()} and no experiment has concluded. ` +
          'Run one first — PRISM-X does not deploy unmeasured changes.',
      );
    }

    // The approval is carried on the deployment rather than the candidate,
    // so it is attached to the specific act it authorised. A candidate
    // approved last month should not silently authorise a deployment today.
    await this.deployments.create({
      candidateId,
      subject: candidate.subject,
      subjectId: candidate.subjectId,
      subjectLabel: candidate.subjectLabel,
      kind: candidate.kind,
      status: DeploymentStatus.PENDING,
      approvedById: ctx.userId,
      approvedAt: new Date(),
      notes: notes ?? null,
      applied: candidate.proposedChange as never,
      rollback: candidate.rollback as never,
      // Which constitution the approver was operating under. An approval
      // given before a law changed is not the same act as one given after,
      // and the archive has to be able to tell them apart.
      constitutionVersion: Constitution.CONSTITUTION_VERSION,
    });

    return candidate;
  }

  // ----------------------------------------------------------------
  // Deployment
  // ----------------------------------------------------------------

  async deploy(candidateId: string, options: { force?: boolean } = {}): Promise<DeployResult> {
    const ctx = RequestContextStore.require();
    const candidate = await this.candidates.findByIdOrFail(candidateId);

    if (candidate.status === CandidateStatus.DEPLOYED) {
      throw new BadRequestException('That candidate is already deployed');
    }
    if (candidate.status !== CandidateStatus.VALIDATED && !options.force) {
      throw new BadRequestException(
        `Only a validated candidate can be deployed; this one is ${candidate.status.toLowerCase()}.`,
      );
    }

    const change = candidate.proposedChange as Record<string, unknown>;

    // 1. What is there now. Read immediately before writing, so the rollback
    //    restores what was actually in production rather than what the
    //    candidate assumed when it was created.
    const before = await this.versions.readCurrent(
      candidate.subject,
      candidate.subjectId,
      Object.keys(change),
    );

    // 2. Policy.
    const trials = await this.weakestArmTrials(candidateId);
    const decision = await this.policy.evaluate(candidate, { benchmarkTrials: trials });
    const approval = await this.findApproval(candidateId);

    // 3. Constitution.
    const subjectOrganizationId = await this.resolveOwner(candidate.subject, candidate.subjectId);
    const verdict = await this.verdictOf(candidate, {
      change,
      before,
      decision,
      approval,
      actorId: ctx.userId,
      actorPermissions: ctx.permissions,
      subjectOrganizationId,
    });

    if (!verdict.permitted) {
      return this.refuse(candidate, verdict, decision, change, before, ctx.userId);
    }

    // 4. Record before acting.
    const policyRecord = await this.policy.get();
    const monitorUntil = new Date(Date.now() + policyRecord.monitorWindowMinutes * 60_000);

    const version = await this.versions.capture({
      subject: candidate.subject,
      subjectId: candidate.subjectId,
      aspect: VersionService.aspectForChange(candidate.subject, change),
      payload: change,
      previous: before,
      label: `deployed ${new Date().toISOString().slice(0, 10)}`,
      notes: candidate.description,
      origin: VersionOrigin.CANDIDATE,
      candidateId: candidate.id,
    });

    const deployment = await this.deployments.create({
      candidateId: candidate.id,
      versionId: version.id,
      subject: candidate.subject,
      subjectId: candidate.subjectId,
      subjectLabel: candidate.subjectLabel,
      kind: candidate.kind,
      status: DeploymentStatus.PENDING,
      applied: change as never,
      rollback: before as never,
      constitutionVersion: verdict.version,
      constitutionPassed: true,
      lawVerdicts: verdict.checked as never,
      policySatisfied: decision.satisfied,
      approvedById: approval?.approvedById ?? null,
      approvedAt: approval?.approvedAt ?? null,
      deployedById: ctx.userId,
      monitorUntil,
      benchmarkSummary: (await this.benchmarkSummary(candidateId)) as never,
    });

    // 5. Apply.
    try {
      await this.write(candidate.subject, candidate.subjectId, change);
      await this.versions.activate(version.id);
    } catch (error) {
      await this.deployments.update(deployment.id, {
        status: DeploymentStatus.FAILED,
        notes: `Write failed: ${(error as Error).message}`,
      });
      throw error;
    }

    const deployed = await this.deployments.update(deployment.id, {
      status: DeploymentStatus.MONITORING,
      deployedAt: new Date(),
    });

    await this.candidateService.setStatus(candidate.id, CandidateStatus.DEPLOYED);

    await this.events.publish(DomainEvent.EvolutionDeployed, {
      deploymentId: deployed.id,
      candidateId: candidate.id,
      subject: candidate.subject,
      subjectId: candidate.subjectId,
      kind: candidate.kind,
      constitutionVersion: verdict.version,
    });

    return { deployment: deployed, deployed: true };
  }

  // ----------------------------------------------------------------
  // Rollback
  // ----------------------------------------------------------------

  async rollback(
    deploymentId: string,
    reason: string,
    options: { automatic?: boolean } = {},
  ): Promise<Deployment> {
    const ctx = RequestContextStore.get();
    const deployment = await this.deployments.findByIdOrFail(deploymentId);

    if (
      deployment.status !== DeploymentStatus.MONITORING &&
      deployment.status !== DeploymentStatus.DEPLOYED &&
      deployment.status !== DeploymentStatus.SETTLED
    ) {
      throw new BadRequestException(
        `A ${deployment.status.toLowerCase()} deployment cannot be rolled back`,
      );
    }

    const restore = deployment.rollback as Record<string, unknown>;
    if (Object.keys(restore).length === 0) {
      // Should be unreachable: the REVERSIBILITY law refuses a deployment
      // without a rollback. Checked anyway, because "unreachable" is a claim
      // about today's code and this is the one place it must hold.
      throw new BadRequestException(
        'This deployment recorded no rollback state, which should have been impossible.',
      );
    }

    await this.write(deployment.subject, deployment.subjectId, restore);

    // The restored state becomes a version of its own rather than
    // reactivating the old row. The lineage then reads as what actually
    // happened — deployed, then reverted — instead of pretending the
    // deployment never occurred.
    const reverted = await this.versions.capture({
      subject: deployment.subject,
      subjectId: deployment.subjectId,
      aspect: VersionService.aspectForChange(
        deployment.subject,
        restore,
      ),
      payload: restore,
      previous: deployment.applied as Record<string, unknown>,
      label: 'rollback',
      notes: reason,
      origin: VersionOrigin.ROLLBACK,
      candidateId: deployment.candidateId ?? undefined,
    });
    await this.versions.activate(reverted.id);

    const rolledBack = await this.deployments.update(deploymentId, {
      status: DeploymentStatus.ROLLED_BACK,
      rolledBackAt: new Date(),
      rolledBackById: options.automatic ? 'system' : (ctx?.userId ?? null),
      rollbackReason: reason,
      automatic: Boolean(options.automatic),
      healthy: false,
    });

    if (deployment.candidateId) {
      await this.candidateService.setStatus(deployment.candidateId, CandidateStatus.REJECTED, {
        rejectedReason: `Rolled back: ${reason}`,
      });
    }

    await this.events.publish(DomainEvent.EvolutionRolledBack, {
      deploymentId,
      subject: deployment.subject,
      subjectId: deployment.subjectId,
      reason,
      automatic: Boolean(options.automatic),
    });

    return rolledBack;
  }

  // ----------------------------------------------------------------
  // Monitoring
  // ----------------------------------------------------------------

  /**
   * Records how a deployed change is behaving.
   *
   * Deployment is not finished when the write lands, it is finished when
   * the change has survived real use. Callers report outcomes here; the
   * sweep decides what they add up to.
   */
  async observe(deploymentId: string, outcome: { succeeded: boolean }): Promise<void> {
    const deployment = await this.deployments.findById(deploymentId);
    if (!deployment || deployment.status !== DeploymentStatus.MONITORING) return;

    await this.deployments.update(deploymentId, {
      monitoredTrials: deployment.monitoredTrials + 1,
      monitoredFailures: deployment.monitoredFailures + (outcome.succeeded ? 0 : 1),
    });

    const policy = await this.policy.get();
    const trials = deployment.monitoredTrials + 1;
    const failures = deployment.monitoredFailures + (outcome.succeeded ? 0 : 1);

    // Rolls back early rather than waiting out the window: once the failure
    // rate is clearly bad, every further minute is damage the system could
    // have prevented and chose not to.
    if (
      policy.autoRollbackEnabled &&
      trials >= 5 &&
      failures / trials >= policy.autoRollbackThreshold
    ) {
      await this.rollback(
        deploymentId,
        `Automatic: ${failures} of ${trials} monitored executions failed, ` +
          `above the ${(policy.autoRollbackThreshold * 100).toFixed(0)}% threshold.`,
        { automatic: true },
      );
    }
  }

  /**
   * Settles deployments whose monitoring window has closed.
   *
   * Runs across every tenant, so it works from unscoped queries and
   * re-enters a scoped context per organization — there is no request here
   * and no user to attribute it to.
   */
  async sweep(): Promise<{ settled: string[]; rolledBack: string[] }> {
    const settled: string[] = [];
    const rolledBack: string[] = [];

    for (const deployment of await this.deployments.findSettleableUnscoped()) {
      await this.asOrganization(deployment.organizationId, async () => {
        const policy = await this.policy.get();
        const failureRate =
          deployment.monitoredTrials > 0
            ? deployment.monitoredFailures / deployment.monitoredTrials
            : 0;

        if (
          policy.autoRollbackEnabled &&
          deployment.monitoredTrials >= 5 &&
          failureRate >= policy.autoRollbackThreshold
        ) {
          await this.rollback(
            deployment.id,
            `Automatic: ${(failureRate * 100).toFixed(0)}% of monitored executions failed.`,
            { automatic: true },
          );
          rolledBack.push(deployment.id);
          return;
        }

        // No observations is not evidence of health. The deployment settles
        // — the window has passed and nobody is going to watch it forever —
        // but `healthy` stays null rather than claiming a verdict nobody
        // measured.
        await this.deployments.update(deployment.id, {
          status: DeploymentStatus.SETTLED,
          healthy: deployment.monitoredTrials > 0 ? failureRate < policy.autoRollbackThreshold : null,
        });

        await this.events.publish(DomainEvent.EvolutionDeploymentSettled, {
          deploymentId: deployment.id,
          monitoredTrials: deployment.monitoredTrials,
          failureRate: Number(failureRate.toFixed(4)),
        });

        settled.push(deployment.id);
      });
    }

    return { settled, rolledBack };
  }

  // ----------------------------------------------------------------
  // Reading
  // ----------------------------------------------------------------

  async history(take = 100): Promise<Deployment[]> {
    return this.deployments.history(take);
  }

  async get(id: string): Promise<Deployment> {
    return this.deployments.findByIdOrFail(id);
  }

  async forSubject(subject: EvolutionSubject, subjectId: string): Promise<Deployment[]> {
    return this.deployments.forSubject(subject, subjectId);
  }

  /** A dry run: what the Constitution and policy would say, changing nothing. */
  async preflight(candidateId: string): Promise<{
    permitted: boolean;
    constitution: Constitution.ConstitutionVerdict;
    policy: Awaited<ReturnType<EvolutionPolicyService['evaluate']>>;
  }> {
    const ctx = RequestContextStore.require();
    const candidate = await this.candidates.findByIdOrFail(candidateId);
    const change = candidate.proposedChange as Record<string, unknown>;

    const before = await this.versions.readCurrent(
      candidate.subject,
      candidate.subjectId,
      Object.keys(change),
    );
    const trials = await this.weakestArmTrials(candidateId);
    const decision = await this.policy.evaluate(candidate, { benchmarkTrials: trials });
    const approval = await this.findApproval(candidateId);
    const subjectOrganizationId = await this.resolveOwner(candidate.subject, candidate.subjectId);

    const constitution = await this.verdictOf(candidate, {
      change,
      before,
      decision,
      approval,
      actorId: ctx.userId,
      actorPermissions: ctx.permissions,
      subjectOrganizationId,
    });

    return {
      permitted: constitution.permitted && decision.satisfied,
      constitution,
      policy: decision,
    };
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private async verdictOf(
    candidate: EvolutionCandidate,
    input: {
      change: Record<string, unknown>;
      before: Record<string, unknown>;
      decision: Awaited<ReturnType<EvolutionPolicyService['evaluate']>>;
      approval: Deployment | null;
      actorId: string;
      actorPermissions: string[];
      subjectOrganizationId: string;
    },
  ): Promise<Constitution.ConstitutionVerdict> {
    const benchmarkVerdict = await this.benchmarkVerdict(candidate.id);

    return Constitution.review({
      organizationId: candidate.organizationId,
      actorId: input.actorId,
      actorPermissions: input.actorPermissions,
      subject: candidate.subject,
      subjectId: candidate.subjectId,
      subjectOrganizationId: input.subjectOrganizationId,
      kind: candidate.kind,
      change: input.change,
      rollback: input.before,
      approvedById: input.approval?.approvedById ?? null,
      approvedAt: input.approval?.approvedAt ?? null,
      policyRequiresApproval: input.decision.requiresApproval,
      policySatisfied: input.decision.satisfied,
      policyReason: input.decision.reason,
      confidence: candidate.confidence,
      benchmarkVerdict,
      auditable: true,
    });
  }

  private async refuse(
    candidate: EvolutionCandidate,
    verdict: Constitution.ConstitutionVerdict,
    decision: Awaited<ReturnType<EvolutionPolicyService['evaluate']>>,
    change: Record<string, unknown>,
    before: Record<string, unknown>,
    actorId: string,
  ): Promise<DeployResult> {
    const deployment = await this.deployments.create({
      candidateId: candidate.id,
      subject: candidate.subject,
      subjectId: candidate.subjectId,
      subjectLabel: candidate.subjectLabel,
      kind: candidate.kind,
      status: DeploymentStatus.REFUSED,
      applied: change as never,
      rollback: before as never,
      constitutionVersion: verdict.version,
      constitutionPassed: false,
      lawVerdicts: verdict.checked as never,
      policySatisfied: decision.satisfied,
      policyReason: decision.reason ?? null,
      deployedById: actorId,
      notes: verdict.violations.map((v) => `${v.lawId}: ${v.reason}`).join('; '),
    });

    for (const violation of verdict.violations) {
      await this.violations.create({
        lawId: violation.lawId,
        reason: violation.reason ?? '',
        subject: candidate.subject,
        subjectId: candidate.subjectId,
        kind: candidate.kind,
        candidateId: candidate.id,
        deploymentId: deployment.id,
        intent: { change, confidence: candidate.confidence, risk: candidate.risk } as never,
        constitutionVersion: verdict.version,
        actorId,
      });

      await this.events.publish(DomainEvent.ConstitutionViolated, {
        lawId: violation.lawId,
        reason: violation.reason,
        candidateId: candidate.id,
        deploymentId: deployment.id,
      });
    }

    await this.events.publish(DomainEvent.EvolutionDeploymentRefused, {
      deploymentId: deployment.id,
      candidateId: candidate.id,
      laws: verdict.violations.map((v) => v.lawId),
    });

    return {
      deployment,
      deployed: false,
      refusal: {
        laws: verdict.violations.map((v) => v.lawId),
        reasons: verdict.violations.map((v) => v.reason ?? ''),
      },
    };
  }

  /**
   * Writes the change.
   *
   * Goes through the ordinary repositories, so tenant scoping and
   * soft-delete filtering apply exactly as they would to a person making the
   * same edit. There is no privileged path — the Evolution Engine is a
   * caller like any other.
   */
  private async write(
    subject: EvolutionSubject,
    subjectId: string,
    change: Record<string, unknown>,
  ): Promise<void> {
    switch (subject) {
      case EvolutionSubject.WORKER:
        await this.workers.update(subjectId, change);
        return;
      case EvolutionSubject.WORKFLOW:
        await this.workflows.update(subjectId, change);
        return;
      case EvolutionSubject.PROVIDER:
        await this.providers.update(subjectId, change);
        return;
      default:
        throw new BadRequestException(
          `${subject} changes have no automatic form and must be made by a person.`,
        );
    }
  }

  /** Which organization actually owns the record being changed. */
  private async resolveOwner(subject: EvolutionSubject, subjectId: string): Promise<string> {
    const ctx = RequestContextStore.require();

    // The repositories are tenant-scoped, so finding the row at all proves
    // it belongs to the caller. A miss means either it does not exist or it
    // is someone else's — and returning a sentinel makes the Constitution
    // refuse rather than this method having to decide which.
    const found =
      subject === EvolutionSubject.WORKER
        ? await this.workers.findById(subjectId)
        : subject === EvolutionSubject.WORKFLOW
          ? await this.workflows.findById(subjectId)
          : subject === EvolutionSubject.PROVIDER
            ? await this.providers.findById(subjectId)
            : null;

    if (found) return (found as { organizationId: string }).organizationId;
    return subject === EvolutionSubject.PLANNING || subject === EvolutionSubject.ORGANIZATION
      ? ctx.organizationId
      : 'unknown';
  }

  /** The most recent unconsumed approval for a candidate. */
  private async findApproval(candidateId: string): Promise<Deployment | null> {
    const pending = await this.deployments.findMany(
      { candidateId, status: DeploymentStatus.PENDING },
      { take: 1, orderBy: { createdAt: 'desc' } },
    );
    return pending[0] ?? null;
  }

  private async benchmarkVerdict(candidateId: string): Promise<BenchmarkVerdict | null> {
    const experiments = await this.experiments.forCandidate(candidateId);
    const concluded = experiments.find((e) => e.verdict);
    return concluded?.verdict ?? null;
  }

  /** Trials on whichever arm has fewer — the binding constraint. */
  private async weakestArmTrials(candidateId: string): Promise<number> {
    const experiments = await this.experiments.forCandidate(candidateId);
    if (experiments.length === 0) return 0;
    return Math.min(
      ...experiments.map((e) => Math.min(e.controlTrials, e.variantTrials)),
    );
  }

  private async benchmarkSummary(candidateId: string): Promise<Record<string, unknown>> {
    const experiments = await this.experiments.forCandidate(candidateId);
    const latest = experiments[0];
    if (!latest) return {};

    const arms = await this.benchmarks.forExperiment(latest.id);
    return {
      experimentId: latest.id,
      mode: latest.mode,
      verdict: latest.verdict,
      confidence: latest.confidence,
      conclusion: latest.conclusion,
      arms: arms.map((a) => ({
        arm: a.arm,
        trials: a.trials,
        successRate: a.successRate,
        avgCostUsd: a.avgCostUsd,
        avgCompletionMs: a.avgCompletionMs,
      })),
    };
  }

  private asOrganization<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return RequestContextStore.run(
      {
        userId: 'system',
        organizationId,
        roleKey: 'SYSTEM',
        permissions: ['*'],
        requestId: `deploy-sweep-${Date.now()}`,
      },
      fn,
    );
  }
}
