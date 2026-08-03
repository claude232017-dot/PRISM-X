import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  Experiment,
  MetricSubject,
  RecommendationKind,
  WorkflowRun,
  WorkflowStepRun,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { ExperimentRepository } from '../database/repositories/learning.repositories';
import {
  WorkflowRepository,
  WorkflowRunRepository,
  WorkflowStepRunRepository,
  WorkflowVersionRepository,
} from '../database/repositories/automation.repositories';
import { WorkflowStep } from '../workflows/execution/execution-adapter.contract';
import { countSteps } from '../workflows/workflow-engine.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RecommendationService } from './recommendation.service';
import { MissionReviewService } from './mission-review.service';
import * as Confidence from './confidence';

export interface StepStat {
  stepId: string;
  runs: number;
  failures: number;
  skipped: number;
  avgDurationMs: number;
  share: number;
  /** Distinct outputs seen. One means the step never changes anything. */
  distinctOutputs: number;
}

export interface WorkflowFinding {
  kind:
    | 'repeated_failure'
    | 'dead_step'
    | 'bottleneck'
    | 'duplicate_action'
    | 'parallelisable'
    | 'missing_guard';
  stepIds: string[];
  detail: string;
  estimatedImpact: number;
  confidence: number;
  samples: number;
}

/**
 * Reads finished workflow runs and says what the graph should look like.
 *
 * Findings come from step-level run history, not from inspecting the graph
 * in isolation. A step that *looks* redundant may be load-bearing, and a step
 * that looks essential may never have changed an outcome in three hundred
 * runs — only the history can tell the two apart.
 *
 * Nothing here edits a workflow. Structural changes are proposed as
 * recommendations with a rollback, and where the improvement is a genuine
 * question rather than a certainty, as an A/B experiment that has to earn
 * its answer.
 */
@Injectable()
export class WorkflowOptimizerService {
  private readonly logger = new Logger(WorkflowOptimizerService.name);

  /** Runs to look back over. */
  static readonly WINDOW = 200;
  /** Runs a workflow needs before its history is worth analysing. */
  static readonly MIN_RUNS = 5;
  /** Share of total step time that makes a step a bottleneck. */
  static readonly BOTTLENECK_SHARE = 0.4;
  /** Failure rate at which a step counts as repeatedly failing. */
  static readonly FAILURE_RATE = 0.25;

  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly versions: WorkflowVersionRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: WorkflowStepRunRepository,
    private readonly experiments: ExperimentRepository,
    private readonly recommendations: RecommendationService,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Analysis
  // ----------------------------------------------------------------

  async analyseAll(): Promise<{ analysed: number; findings: number; recommended: number }> {
    const workflows = await this.workflows.findMany({});
    let analysed = 0;
    let findings = 0;
    let recommended = 0;

    for (const workflow of workflows) {
      const result = await this.analyse(workflow.id);
      if (result.findings.length > 0 || result.samples >= WorkflowOptimizerService.MIN_RUNS) {
        analysed += 1;
      }
      findings += result.findings.length;
      recommended += result.recommended;
    }

    return { analysed, findings, recommended };
  }

  async analyse(workflowId: string): Promise<{
    findings: WorkflowFinding[];
    stats: StepStat[];
    samples: number;
    recommended: number;
  }> {
    const workflow = await this.workflows.findByIdOrFail(workflowId);
    const runs = await this.runs.findMany(
      { workflowId },
      { take: WorkflowOptimizerService.WINDOW, orderBy: { startedAt: 'desc' } },
    );

    if (runs.length < WorkflowOptimizerService.MIN_RUNS) {
      // Below this, every "finding" is a coincidence with a confident
      // sentence attached to it.
      return { findings: [], stats: [], samples: runs.length, recommended: 0 };
    }

    const stepRuns: WorkflowStepRun[] = [];
    for (const run of runs.slice(0, 50)) {
      stepRuns.push(...(await this.stepRuns.findByRun(run.id)));
    }

    const steps = await this.stepsOf(workflowId);
    const stats = WorkflowOptimizerService.stepStats(stepRuns);
    const findings = WorkflowOptimizerService.findings(stats, steps, runs);

    const recommended = await this.proposeFrom(workflow.id, workflow.name, findings, steps);

    return { findings, stats, samples: runs.length, recommended };
  }

  private async stepsOf(workflowId: string): Promise<WorkflowStep[]> {
    const workflow = await this.workflows.findById(workflowId);
    if (!workflow?.activeVersionId) return [];
    const version = await this.versions.findById(workflow.activeVersionId);
    return ((version?.steps ?? []) as unknown as WorkflowStep[]) ?? [];
  }

  private async proposeFrom(
    workflowId: string,
    workflowName: string,
    findings: WorkflowFinding[],
    steps: WorkflowStep[],
  ): Promise<number> {
    let proposed = 0;

    for (const finding of findings) {
      const kind = WorkflowOptimizerService.recommendationKindFor(finding.kind);

      // A structural rewrite is proposed as data the human can inspect: the
      // current graph is the rollback, so accepting is reversible by
      // construction rather than by promise.
      await this.recommendations.propose({
        kind,
        subject: MetricSubject.WORKFLOW,
        subjectId: workflowId,
        subjectLabel: workflowName,
        title: WorkflowOptimizerService.titleFor(finding, workflowName),
        reasoning: finding.detail,
        evidence: {
          stepIds: finding.stepIds,
          samples: finding.samples,
          finding: finding.kind,
        },
        estimatedImpact: finding.estimatedImpact,
        impactSummary: WorkflowOptimizerService.impactSummaryFor(finding),
        risk: RecommendationService.riskFor(kind, finding.confidence),
        riskNotes:
          kind === RecommendationKind.WORKFLOW_PRUNE
            ? 'Removing a step is hard to undo once later runs depend on its absence. Review the step first.'
            : undefined,
        // The proposal describes the change; it does not pre-compute a new
        // graph, because rewriting someone's workflow structure without them
        // seeing it is exactly what the validation layer exists to prevent.
        proposedChange: {},
        rollback: { steps: steps as never },
        confidence: finding.confidence,
        sampleSize: finding.samples,
      });
      proposed += 1;
    }

    return proposed;
  }

  // ----------------------------------------------------------------
  // A/B testing
  // ----------------------------------------------------------------

  /**
   * Starts an experiment between the active version and a candidate.
   *
   * The alternative to measuring is guessing, and a workflow change that
   * "looks better" is precisely the sort of claim that turns out to be a
   * seasonal effect. One running experiment per workflow, because two
   * overlapping ones make both uninterpretable.
   */
  async startExperiment(input: {
    workflowId: string;
    variantVersionId: string;
    name: string;
    hypothesis: string;
    allocation?: number;
    minRunsPerArm?: number;
  }): Promise<Experiment> {
    const workflow = await this.workflows.findByIdOrFail(input.workflowId);
    if (!workflow.activeVersionId) {
      throw new BadRequestException(
        'That workflow has no active version to test against — publish one first.',
      );
    }
    if (workflow.activeVersionId === input.variantVersionId) {
      throw new BadRequestException('The variant must differ from the active version');
    }

    const variant = await this.versions.findById(input.variantVersionId);
    if (!variant || variant.workflowId !== input.workflowId) {
      throw new BadRequestException('That version does not belong to this workflow');
    }

    const running = await this.experiments.findRunningForWorkflow(input.workflowId);
    if (running) {
      throw new BadRequestException(
        `"${running.name}" is already running on this workflow. Conclude it first — ` +
          'two overlapping experiments make both uninterpretable.',
      );
    }

    const allocation = Math.min(0.9, Math.max(0.1, input.allocation ?? 0.5));

    const experiment = await this.experiments.create({
      workflowId: input.workflowId,
      name: input.name,
      hypothesis: input.hypothesis,
      controlVersionId: workflow.activeVersionId,
      variantVersionId: input.variantVersionId,
      allocation,
      minRunsPerArm: input.minRunsPerArm ?? 20,
      status: 'RUNNING',
    });

    await this.events.publish(DomainEvent.ExperimentStarted, {
      experimentId: experiment.id,
      workflowId: input.workflowId,
      allocation,
    });

    return experiment;
  }

  /**
   * Which arm a given run belongs to.
   *
   * Deterministic on the run id rather than random, so the assignment can be
   * recomputed later from the record. A random allocation nobody stored is
   * an experiment whose results cannot be audited.
   */
  static armFor(experiment: Pick<Experiment, 'id' | 'allocation'>, runId: string): 'control' | 'variant' {
    const digest = createHash('sha256').update(`${experiment.id}:${runId}`).digest();
    const bucket = digest.readUInt32BE(0) / 0xffffffff;
    return bucket < experiment.allocation ? 'variant' : 'control';
  }

  async recordRun(
    workflowId: string,
    runId: string,
    result: { succeeded: boolean; durationMs: number; costUsd: number },
  ): Promise<{ recorded: boolean; arm?: 'control' | 'variant' }> {
    const experiment = await this.experiments.findRunningForWorkflow(workflowId);
    if (!experiment) return { recorded: false };

    const arm = WorkflowOptimizerService.armFor(experiment, runId);
    await this.experiments.recordRun(experiment.id, arm, result);
    return { recorded: true, arm };
  }

  /**
   * Declares a winner, or explains why it cannot yet.
   *
   * Both gates matter: enough runs per arm, *and* intervals that actually
   * separate. Stopping at the first favourable number is worse than not
   * measuring, because it lends noise the authority of an experiment.
   */
  async evaluate(experimentId: string): Promise<Experiment> {
    const experiment = await this.experiments.findByIdOrFail(experimentId);

    if (
      experiment.controlRuns < experiment.minRunsPerArm ||
      experiment.variantRuns < experiment.minRunsPerArm
    ) {
      return this.experiments.update(experimentId, {
        conclusion:
          `Still collecting: control ${experiment.controlRuns}/${experiment.minRunsPerArm}, ` +
          `variant ${experiment.variantRuns}/${experiment.minRunsPerArm}.`,
      });
    }

    const comparison = Confidence.comparisonConfidence(
      { successes: experiment.variantSuccesses, trials: experiment.variantRuns },
      { successes: experiment.controlSuccesses, trials: experiment.controlRuns },
    );

    if (comparison.value === 0) {
      return this.experiments.update(experimentId, {
        confidence: 0,
        conclusion:
          'No winner: the two arms overlap within their margins of error. ' +
          `${comparison.rationale}`,
      });
    }

    const variantRate = experiment.variantSuccesses / experiment.variantRuns;
    const controlRate = experiment.controlSuccesses / experiment.controlRuns;
    const winner = variantRate > controlRate ? 'variant' : 'control';

    const concluded = await this.experiments.update(experimentId, {
      status: 'CONCLUDED',
      winner,
      confidence: comparison.value,
      concludedAt: new Date(),
      conclusion:
        `${winner} wins: ${(Math.max(variantRate, controlRate) * 100).toFixed(1)}% against ` +
        `${(Math.min(variantRate, controlRate) * 100).toFixed(1)}%. ${comparison.rationale}`,
    });

    await this.events.publish(DomainEvent.ExperimentConcluded, {
      experimentId,
      winner,
      confidence: comparison.value,
    });

    return concluded;
  }

  async listExperiments(): Promise<Experiment[]> {
    return this.experiments.findMany({}, { orderBy: { startedAt: 'desc' }, take: 50 });
  }

  async abandon(experimentId: string, reason: string): Promise<Experiment> {
    return this.experiments.update(experimentId, {
      status: 'ABANDONED',
      concludedAt: new Date(),
      conclusion: reason,
    });
  }

  // ----------------------------------------------------------------
  // Pure analysis
  // ----------------------------------------------------------------

  static stepStats(stepRuns: WorkflowStepRun[]): StepStat[] {
    const groups = new Map<string, WorkflowStepRun[]>();
    for (const step of stepRuns) {
      const bucket = groups.get(step.stepId);
      if (bucket) bucket.push(step);
      else groups.set(step.stepId, [step]);
    }

    const totalMs = stepRuns.reduce((sum, s) => sum + WorkflowOptimizerService.durationOf(s), 0);

    return [...groups.entries()].map(([stepId, group]) => {
      const durations = group.map((s) => WorkflowOptimizerService.durationOf(s));
      const stepMs = durations.reduce((sum, d) => sum + d, 0);

      return {
        stepId,
        runs: group.length,
        failures: group.filter((s) => s.status === 'FAILED').length,
        skipped: group.filter((s) => s.status === 'SKIPPED').length,
        avgDurationMs: Number((stepMs / group.length).toFixed(2)),
        share: totalMs > 0 ? Number((stepMs / totalMs).toFixed(4)) : 0,
        distinctOutputs: new Set(
          group.map((s) => JSON.stringify(s.output ?? null)),
        ).size,
      };
    });
  }

  static findings(
    stats: StepStat[],
    steps: WorkflowStep[],
    runs: WorkflowRun[],
  ): WorkflowFinding[] {
    const findings: WorkflowFinding[] = [];
    const byId = new Map(WorkflowOptimizerService.flatten(steps).map((s) => [s.id, s]));

    for (const stat of stats) {
      if (stat.runs < 3) continue;

      const failureRate = stat.failures / stat.runs;
      if (failureRate >= WorkflowOptimizerService.FAILURE_RATE) {
        findings.push({
          kind: 'repeated_failure',
          stepIds: [stat.stepId],
          detail:
            `Step "${stat.stepId}" failed in ${stat.failures} of ${stat.runs} runs ` +
            `(${(failureRate * 100).toFixed(0)}%). Everything downstream of it inherits that rate.`,
          estimatedImpact: Math.min(1, failureRate),
          confidence: Confidence.score({ samples: stat.runs }).value,
          samples: stat.runs,
        });
      }

      if (stat.share >= WorkflowOptimizerService.BOTTLENECK_SHARE && stats.length > 1) {
        findings.push({
          kind: 'bottleneck',
          stepIds: [stat.stepId],
          detail:
            `Step "${stat.stepId}" accounts for ${(stat.share * 100).toFixed(0)}% of total ` +
            `step time (${(stat.avgDurationMs / 1000).toFixed(1)}s average across ${stat.runs} runs).`,
          estimatedImpact: Math.min(0.8, stat.share),
          confidence: Confidence.score({ samples: stat.runs }).value,
          samples: stat.runs,
        });
      }

      // Always skipped means the condition guarding it has never been true.
      if (stat.skipped === stat.runs && stat.runs >= 5) {
        findings.push({
          kind: 'dead_step',
          stepIds: [stat.stepId],
          detail:
            `Step "${stat.stepId}" was skipped in all ${stat.runs} runs — its condition ` +
            'has never been satisfied. Either the condition is wrong or the step is dead.',
          estimatedImpact: 0.2,
          confidence: Confidence.score({ samples: stat.runs }).value,
          samples: stat.runs,
        });
      }

      // One distinct output across many runs means the step computes the
      // same thing every time and could be hoisted, cached or removed.
      if (stat.distinctOutputs === 1 && stat.runs >= 10 && stat.skipped === 0) {
        findings.push({
          kind: 'duplicate_action',
          stepIds: [stat.stepId],
          detail:
            `Step "${stat.stepId}" produced an identical result in all ${stat.runs} runs. ` +
            'It may be recomputing a constant.',
          estimatedImpact: Math.min(0.4, stat.share),
          confidence: Confidence.score({ samples: stat.runs }).value,
          samples: stat.runs,
        });
      }
    }

    // Independent steps that always run one after the other.
    const independent = WorkflowOptimizerService.flatten(steps).filter(
      (s) => !s.dependsOn || s.dependsOn.length === 0,
    );
    if (independent.length > 1 && stats.length > 1) {
      const slowest = independent
        .map((s) => stats.find((stat) => stat.stepId === s.id))
        .filter((s): s is StepStat => Boolean(s) && s!.runs >= 5);

      if (slowest.length > 1) {
        const serialMs = slowest.reduce((sum, s) => sum + s.avgDurationMs, 0);
        const longest = Math.max(...slowest.map((s) => s.avgDurationMs));
        const saving = serialMs - longest;

        if (saving > 1000) {
          findings.push({
            kind: 'parallelisable',
            stepIds: slowest.map((s) => s.stepId),
            detail:
              `${slowest.length} steps have no dependencies on one another but run in ` +
              `sequence, costing about ${(saving / 1000).toFixed(1)}s per run.`,
            estimatedImpact: Math.min(0.6, saving / Math.max(1, serialMs)),
            confidence: Confidence.score({
              samples: Math.min(...slowest.map((s) => s.runs)),
            }).value,
            samples: Math.min(...slowest.map((s) => s.runs)),
          });
        }
      }
    }

    // Runs that failed with the same error and no approval step in the graph.
    const errors = runs
      .filter((r) => r.status === 'FAILED' && r.error)
      .map((r) => MissionReviewService.errorSignature(r.error!));
    const repeated = WorkflowOptimizerService.mostCommon(errors);
    const hasApproval = WorkflowOptimizerService.flatten(steps).some(
      (s) => s.type === 'approval',
    );

    if (repeated && repeated.count >= 3 && !hasApproval) {
      findings.push({
        kind: 'missing_guard',
        stepIds: [],
        detail:
          `${repeated.count} runs failed with the same error and the workflow has no ` +
          `approval or guard step: "${repeated.value.slice(0, 120)}".`,
        estimatedImpact: Math.min(0.5, repeated.count / Math.max(1, runs.length)),
        confidence: Confidence.score({ samples: repeated.count }).value,
        samples: repeated.count,
      });
    }

    return findings.sort((a, b) => b.estimatedImpact * b.confidence - a.estimatedImpact * a.confidence);
  }

  static recommendationKindFor(finding: WorkflowFinding['kind']): RecommendationKind {
    switch (finding) {
      case 'dead_step':
      case 'duplicate_action':
        return RecommendationKind.WORKFLOW_PRUNE;
      case 'parallelisable':
        return RecommendationKind.WORKFLOW_PARALLELISE;
      case 'missing_guard':
        return RecommendationKind.WORKFLOW_GUARD;
      default:
        return RecommendationKind.WORKFLOW_STRUCTURE;
    }
  }

  static titleFor(finding: WorkflowFinding, workflowName: string): string {
    switch (finding.kind) {
      case 'repeated_failure':
        return `Fix the failing step in ${workflowName}`;
      case 'bottleneck':
        return `Speed up "${finding.stepIds[0]}" in ${workflowName}`;
      case 'dead_step':
        return `Remove the unreachable step in ${workflowName}`;
      case 'duplicate_action':
        return `Cache or remove the constant step in ${workflowName}`;
      case 'parallelisable':
        return `Run ${finding.stepIds.length} independent steps in parallel in ${workflowName}`;
      default:
        return `Add a guard to ${workflowName}`;
    }
  }

  static impactSummaryFor(finding: WorkflowFinding): string {
    switch (finding.kind) {
      case 'repeated_failure':
        return `up to ${(finding.estimatedImpact * 100).toFixed(0)}% fewer failed runs`;
      case 'bottleneck':
      case 'parallelisable':
        return `up to ${(finding.estimatedImpact * 100).toFixed(0)}% less time per run`;
      case 'dead_step':
      case 'duplicate_action':
        return 'a simpler graph and slightly less work per run';
      default:
        return 'fewer avoidable failures';
    }
  }

  /** Flattens nested branches and children into one list. */
  static flatten(steps: WorkflowStep[]): WorkflowStep[] {
    const out: WorkflowStep[] = [];
    const walk = (list: WorkflowStep[] = []) => {
      for (const step of list) {
        out.push(step);
        walk(step.steps);
        walk(step.onTrue);
        walk(step.onFalse);
      }
    };
    walk(steps);
    return out;
  }

  static countSteps = countSteps;

  static durationOf(step: WorkflowStepRun): number {
    if (step.durationMs) return step.durationMs;
    if (step.finishedAt) return step.finishedAt.getTime() - step.startedAt.getTime();
    return 0;
  }

  static mostCommon(values: string[]): { value: string; count: number } | null {
    if (values.length === 0) return null;
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

    let best: { value: string; count: number } | null = null;
    for (const [value, count] of counts) {
      if (!best || count > best.count) best = { value, count };
    }
    return best;
  }
}
