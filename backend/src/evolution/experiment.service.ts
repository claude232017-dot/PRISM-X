import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  BenchmarkVerdict,
  CandidateStatus,
  EvolutionExperiment,
  ExperimentMode,
  VersionAspect,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  EvolutionCandidateRepository,
  EvolutionExperimentRepository,
} from '../database/repositories/evolution.repositories';
import { WorkerRepository } from '../database/repositories/tenant.repositories';
import { WorkerRuntimeService } from '../workers/runtime/worker-runtime.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { BenchmarkService, Trial } from './benchmark.service';
import { EvolutionPolicyService } from './policy.service';
import { VersionService } from './version.service';
import { CandidateService } from './candidate.service';

export interface StartExperimentInput {
  candidateId: string;
  mode?: ExperimentMode;
  name?: string;
  hypothesis?: string;
  allocation?: number;
  minTrialsPerArm?: number;
}

export interface RunTrialsInput {
  experimentId: string;
  /** How many trials to run against each arm. */
  trials?: number;
  /** Instructions to exercise the subject with. */
  probes?: string[];
}

/**
 * Tests a candidate against what it would replace, without production
 * finding out.
 *
 * Four modes, ordered by how much of the real system they touch:
 *
 *  - **SANDBOX** — the candidate is applied to a throwaway copy and probed
 *    directly. Nothing real is read or written. Always permitted, because an
 *    organization that cannot measure anything will deploy on a hunch.
 *  - **SHADOW** — the candidate runs alongside production on the same work.
 *    Its results are recorded and discarded; production uses the control's.
 *  - **CANARY** — a small share of real work goes to the candidate.
 *  - **AB** — an even split.
 *
 * The mode is a policy decision, not a technical one, which is why the
 * policy layer gates it. What is *not* negotiable is that the candidate is
 * never simply applied and observed: a change that has been deployed in
 * order to test it has already skipped the pipeline.
 */
@Injectable()
export class ExperimentService {
  private readonly logger = new Logger(ExperimentService.name);

  /** Trials per arm when a caller does not say. */
  static readonly DEFAULT_TRIALS = 12;
  /** Ceiling, so one call cannot spend an afternoon and a budget. */
  static readonly MAX_TRIALS = 50;

  /** Probes used when the caller supplies none. */
  static readonly DEFAULT_PROBES = [
    'Summarise the current state of this task in two sentences.',
    'List the three most important risks in what you have been asked to do.',
    'Explain your approach before carrying it out.',
  ];

  constructor(
    private readonly experiments: EvolutionExperimentRepository,
    private readonly candidates: EvolutionCandidateRepository,
    private readonly workers: WorkerRepository,
    private readonly runtime: WorkerRuntimeService,
    private readonly benchmarks: BenchmarkService,
    private readonly policy: EvolutionPolicyService,
    private readonly versions: VersionService,
    private readonly candidateService: CandidateService,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  async start(input: StartExperimentInput): Promise<EvolutionExperiment> {
    const candidate = await this.candidates.findByIdOrFail(input.candidateId);

    if (candidate.status === CandidateStatus.DEPLOYED) {
      throw new BadRequestException('That candidate has already been deployed');
    }
    if (candidate.status === CandidateStatus.REJECTED) {
      throw new BadRequestException('That candidate was rejected; re-propose it first');
    }

    const mode = input.mode ?? ExperimentMode.SANDBOX;
    const permitted = await this.policy.canExperiment(mode);
    if (!permitted.satisfied) {
      throw new ForbiddenException(`Experiment refused: ${permitted.reason}`);
    }

    const running = await this.experiments.findRunningForCandidate(candidate.id);
    if (running) {
      throw new BadRequestException(
        `"${running.name}" is already running for this candidate. ` +
          'Two overlapping experiments on one change make both uninterpretable.',
      );
    }

    const policy = await this.policy.get();

    // Both arms get a version row before anything runs, so the comparison
    // is between two named, inspectable states rather than between "now"
    // and "whatever now becomes".
    const aspect = VersionService.aspectForChange(
      candidate.subject,
      candidate.proposedChange as Record<string, unknown>,
    );
    const control = await this.versions.ensureBaseline(
      candidate.subject,
      candidate.subjectId,
      aspect,
    );
    const variant = await this.versions.capture({
      subject: candidate.subject,
      subjectId: candidate.subjectId,
      aspect,
      payload: candidate.proposedChange as Record<string, unknown>,
      previous: candidate.rollback as Record<string, unknown>,
      label: `candidate ${candidate.id.slice(-6)}`,
      notes: candidate.description,
      origin: 'CANDIDATE',
      candidateId: candidate.id,
    });

    const experiment = await this.experiments.create({
      candidateId: candidate.id,
      mode,
      name: input.name ?? candidate.description.slice(0, 120),
      hypothesis: input.hypothesis ?? candidate.expectedBenefit,
      controlVersionId: control.id,
      variantVersionId: variant.id,
      allocation:
        mode === ExperimentMode.CANARY
          ? Math.min(0.25, input.allocation ?? 0.1)
          : Math.min(0.9, Math.max(0.1, input.allocation ?? 0.5)),
      minTrialsPerArm: input.minTrialsPerArm ?? policy.minTrialsPerArm,
      status: 'RUNNING',
    });

    await this.candidateService.setStatus(candidate.id, CandidateStatus.TESTING);

    await this.events.publish(DomainEvent.EvolutionExperimentStarted, {
      experimentId: experiment.id,
      candidateId: candidate.id,
      mode,
      allocation: experiment.allocation,
    });

    return experiment;
  }

  async list(take = 50): Promise<EvolutionExperiment[]> {
    return this.experiments.findMany({}, { take, orderBy: { startedAt: 'desc' } });
  }

  async get(id: string): Promise<EvolutionExperiment> {
    return this.experiments.findByIdOrFail(id);
  }

  async abandon(id: string, reason: string): Promise<EvolutionExperiment> {
    const experiment = await this.experiments.findByIdOrFail(id);
    const abandoned = await this.experiments.update(id, {
      status: 'ABANDONED',
      concludedAt: new Date(),
      conclusion: reason,
    });
    await this.candidateService.setStatus(experiment.candidateId, CandidateStatus.QUEUED);
    return abandoned;
  }

  // ----------------------------------------------------------------
  // Running trials
  // ----------------------------------------------------------------

  /**
   * Exercises both arms and records their benchmarks.
   *
   * The control arm runs the subject as production has it. The variant runs
   * it with the candidate's change applied *in memory only* — the worker
   * record is never written, which is what makes a sandbox a sandbox. A
   * failed trial is a data point, not an error, so exceptions are caught and
   * counted rather than aborting the run.
   */
  async runTrials(input: RunTrialsInput): Promise<{
    experiment: EvolutionExperiment;
    control: number;
    variant: number;
    verdict: BenchmarkVerdict;
  }> {
    const experiment = await this.experiments.findByIdOrFail(input.experimentId);
    if (experiment.status !== 'RUNNING') {
      throw new BadRequestException(`That experiment is ${experiment.status.toLowerCase()}`);
    }

    const candidate = await this.candidates.findByIdOrFail(experiment.candidateId);
    const count = Math.min(
      ExperimentService.MAX_TRIALS,
      Math.max(1, input.trials ?? ExperimentService.DEFAULT_TRIALS),
    );
    const probes = input.probes?.length ? input.probes : ExperimentService.DEFAULT_PROBES;

    const controlTrials: Trial[] = [];
    const variantTrials: Trial[] = [];

    for (let i = 0; i < count; i += 1) {
      const probe = probes[i % probes.length];

      // Allocation only means something when real work is being routed. In
      // SANDBOX nothing real is touched and in SHADOW the candidate sees
      // everything by definition, so both arms run every trial: splitting
      // them would halve the statistical power for no safety benefit and
      // make a sandbox experiment need twice the trials to say anything.
      const paired =
        experiment.mode === ExperimentMode.SHADOW || experiment.mode === ExperimentMode.SANDBOX;
      const arm = ExperimentService.armFor(experiment, `${experiment.id}:${i}`);
      const runControl = paired || arm === 'control';
      const runVariant = paired || arm === 'variant';

      if (runControl) {
        controlTrials.push(await this.probe(candidate.subjectId, probe, null));
        await this.experiments.recordTrial(experiment.id, 'control');
      }
      if (runVariant) {
        variantTrials.push(
          await this.probe(
            candidate.subjectId,
            probe,
            candidate.proposedChange as Record<string, unknown>,
          ),
        );
        await this.experiments.recordTrial(experiment.id, 'variant');
      }
    }

    if (controlTrials.length > 0) {
      await this.benchmarks.record(experiment.id, 'control', controlTrials);
    }
    if (variantTrials.length > 0) {
      await this.benchmarks.record(experiment.id, 'variant', variantTrials);
    }

    const comparison = await this.benchmarks.compare(
      experiment.id,
      experiment.minTrialsPerArm,
    );

    return {
      experiment: await this.experiments.findByIdOrFail(experiment.id),
      control: controlTrials.length,
      variant: variantTrials.length,
      verdict: comparison.verdict,
    };
  }

  /**
   * One measured execution.
   *
   * `overrides` are applied to the worker object handed to the runtime and
   * never persisted — the difference between testing a change and making
   * it. Failures are recorded as unsuccessful trials rather than thrown,
   * because "this variant crashes" is exactly the finding an experiment
   * exists to produce.
   */
  private async probe(
    workerId: string,
    instruction: string,
    overrides: Record<string, unknown> | null,
  ): Promise<Trial> {
    const startedAt = Date.now();

    try {
      const worker = await this.workers.findById(workerId);
      if (!worker) {
        return {
          succeeded: false, completionMs: 0, costUsd: 0, tokens: 0, latencyMs: 0,
        };
      }

      const result = await this.runtime.execute({
        workerId,
        instruction,
        skipRetrieval: true,
        forceLocal: true,
        // The candidate's provider override is the one change that has to
        // reach the runtime, since it decides which vendor answers.
        ...(overrides?.providerId ? { providerId: String(overrides.providerId) } : {}),
        overrides: overrides ?? undefined,
      });

      return {
        succeeded: result.status === 'SUCCEEDED',
        completionMs: Date.now() - startedAt,
        costUsd: result.costUsd,
        tokens: result.totalTokens,
        latencyMs: result.latencyMs,
        retried: result.iterations > 1,
        quality: result.status === 'SUCCEEDED' && result.output.length > 0 ? 1 : 0,
      };
    } catch {
      return {
        succeeded: false,
        completionMs: Date.now() - startedAt,
        costUsd: 0,
        tokens: 0,
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  // ----------------------------------------------------------------
  // Concluding
  // ----------------------------------------------------------------

  /**
   * Decides the experiment, or explains why it cannot yet.
   *
   * A candidate whose variant loses is rejected here, without a human ever
   * reading it. That is the point of the pipeline: most proposed changes
   * are not improvements, and the measurement should be what discovers that
   * rather than someone's afternoon.
   */
  async evaluate(id: string): Promise<{
    experiment: EvolutionExperiment;
    comparison: Awaited<ReturnType<BenchmarkService['compare']>>;
  }> {
    const experiment = await this.experiments.findByIdOrFail(id);
    const comparison = await this.benchmarks.compare(id, experiment.minTrialsPerArm);

    if (comparison.verdict === BenchmarkVerdict.INSUFFICIENT_DATA) {
      const updated = await this.experiments.update(id, {
        verdict: comparison.verdict,
        conclusion: comparison.summary,
      });
      return { experiment: updated, comparison };
    }

    const concluded = await this.experiments.update(id, {
      status: 'CONCLUDED',
      verdict: comparison.verdict,
      winner: comparison.winner,
      confidence: comparison.confidence,
      conclusion: comparison.summary,
      concludedAt: new Date(),
    });

    if (comparison.verdict === BenchmarkVerdict.BETTER) {
      await this.candidateService.setStatus(experiment.candidateId, CandidateStatus.VALIDATED);
      await this.events.publish(DomainEvent.EvolutionCandidateValidated, {
        candidateId: experiment.candidateId,
        experimentId: id,
        confidence: comparison.confidence,
      });
    } else if (comparison.verdict === BenchmarkVerdict.WORSE) {
      await this.candidateService.setStatus(experiment.candidateId, CandidateStatus.REJECTED, {
        rejectedReason: comparison.summary,
      });
      await this.events.publish(DomainEvent.EvolutionCandidateRejected, {
        candidateId: experiment.candidateId,
        experimentId: id,
        reason: comparison.summary,
      });
    } else {
      // Inconclusive is not refutation. The measurement failed to tell the
      // two apart, which leaves the candidate exactly where it started
      // rather than disproving it — a change proposed for a reason the
      // benchmark does not measure (maintainability, a contractual model
      // requirement) is still perfectly reasonable. It goes back on the
      // queue, where it can be re-tested with more trials or approved by a
      // person who has a reason the numbers cannot see.
      await this.candidateService.setStatus(experiment.candidateId, CandidateStatus.QUEUED, {
        rejectedReason: null,
      });
    }

    await this.events.publish(DomainEvent.EvolutionExperimentConcluded, {
      experimentId: id,
      verdict: comparison.verdict,
      winner: comparison.winner,
      confidence: comparison.confidence,
    });

    return { experiment: concluded, comparison };
  }

  // ----------------------------------------------------------------
  // Pure helpers
  // ----------------------------------------------------------------

  /**
   * Which arm a trial belongs to.
   *
   * Deterministic on the trial key rather than random, so an allocation can
   * be recomputed from the record afterwards. A random split nobody stored
   * is an experiment whose results cannot be audited.
   */
  static armFor(
    experiment: Pick<EvolutionExperiment, 'id' | 'allocation' | 'mode'>,
    trialKey: string,
  ): 'control' | 'variant' {
    // Both paired modes run every trial against both arms, so there is no
    // allocation decision to make.
    if (
      experiment.mode === ExperimentMode.SHADOW ||
      experiment.mode === ExperimentMode.SANDBOX
    ) {
      return 'variant';
    }

    const digest = createHash('sha256').update(`${experiment.id}:${trialKey}`).digest();
    const bucket = digest.readUInt32BE(0) / 0xffffffff;
    return bucket < experiment.allocation ? 'variant' : 'control';
  }

  /** How much of the real system each mode touches, for display and policy. */
  static exposureOf(mode: ExperimentMode): 'none' | 'observed' | 'partial' | 'split' {
    switch (mode) {
      case ExperimentMode.SANDBOX:
        return 'none';
      case ExperimentMode.SHADOW:
        return 'observed';
      case ExperimentMode.CANARY:
        return 'partial';
      default:
        return 'split';
    }
  }
}
