import { Injectable, Logger } from '@nestjs/common';
import {
  ExecutionLog,
  MetricSubject,
  RecommendationKind,
  Worker,
  WorkerProfile,
} from '@prisma/client';
import { WorkerProfileRepository } from '../database/repositories/learning.repositories';
import { ExecutionLogRepository } from '../database/repositories/execution.repositories';
import {
  ProviderRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import { ToolCallRepository } from '../database/repositories/execution.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RecommendationService } from './recommendation.service';
import { MissionReviewService } from './mission-review.service';
import * as Confidence from './confidence';

interface ProviderArm {
  providerId: string;
  model: string | null;
  label: string;
  runs: number;
  successes: number;
  avgCostUsd: number;
  avgLatencyMs: number;
}

/**
 * What the system learns about each worker, and what it suggests doing.
 *
 * The profile is an observation; the worker's configuration is a decision.
 * Nothing here writes to a worker — the optimizer proposes, and the
 * recommendation gate decides. That separation is the point: a worker whose
 * prompt silently changes because last week's numbers moved is a worker
 * nobody can debug.
 *
 * Profiles are rebuilt from execution history rather than edited
 * incrementally, so a profile always agrees with the logs it claims to
 * summarise and a bad update cannot accumulate.
 */
@Injectable()
export class WorkerOptimizerService {
  private readonly logger = new Logger(WorkerOptimizerService.name);

  /** Executions to look back over when profiling. */
  static readonly WINDOW = 200;
  /** Runs an arm needs before it can be compared against another. */
  static readonly MIN_ARM_RUNS = 5;
  /** Relative improvement worth proposing a switch for. */
  static readonly MIN_UPLIFT = 0.1;

  constructor(
    private readonly profiles: WorkerProfileRepository,
    private readonly workers: WorkerRepository,
    private readonly providers: ProviderRepository,
    private readonly executionLogs: ExecutionLogRepository,
    private readonly toolCalls: ToolCallRepository,
    private readonly recommendations: RecommendationService,
    private readonly events: EventBusService,
  ) {}

  /** Rebuilds every worker's profile and proposes what follows from it. */
  async analyseAll(): Promise<{ profiled: number; recommended: number }> {
    const workers = await this.workers.findMany({});
    let profiled = 0;
    let recommended = 0;

    for (const worker of workers) {
      const result = await this.analyse(worker.id);
      if (result.profile) profiled += 1;
      recommended += result.recommendations;
    }

    return { profiled, recommended };
  }

  async analyse(
    workerId: string,
  ): Promise<{ profile: WorkerProfile | null; recommendations: number }> {
    const worker = await this.workers.findByIdOrFail(workerId);
    const logs = await this.executionLogs.findByWorker(workerId, WorkerOptimizerService.WINDOW);

    if (logs.length === 0) {
      // No history is not a finding. Writing an empty profile would make a
      // brand-new worker look measured rather than unknown.
      return { profile: null, recommendations: 0 };
    }

    const calls = await this.toolCalls.findMany({ workerId }, { take: 500 });
    const arms = WorkerOptimizerService.armsFrom(logs);
    const best = WorkerOptimizerService.bestArm(arms);

    const successes = logs.filter((l) => l.status === 'SUCCEEDED').length;
    const durations = logs.map((l) => l.latencyMs).filter((n) => n > 0);
    const failures = WorkerOptimizerService.failureTypes(logs);

    const confidence = Confidence.score({
      samples: logs.length,
      consistency: Confidence.consistencyOf(durations),
      ageDays: WorkerOptimizerService.ageDays(logs),
    });

    const profile = await this.profiles.upsertForWorker(workerId, {
      preferredProviderId: best?.providerId ?? worker.providerId ?? null,
      preferredModel: best?.model ?? worker.defaultModel ?? null,
      preferenceEvidence: { arms } as never,
      executions: logs.length,
      successes,
      successRate: Confidence.wilsonLowerBound(successes, logs.length),
      avgQuality: WorkerOptimizerService.qualityOf(logs),
      avgCostUsd: Number(
        (logs.reduce((s, l) => s + l.costUsd, 0) / logs.length).toFixed(6),
      ),
      avgDurationMs: Number(
        (durations.reduce((s, d) => s + d, 0) / Math.max(1, durations.length)).toFixed(2),
      ),
      avgTokens: Math.round(logs.reduce((s, l) => s + l.totalTokens, 0) / logs.length),
      toolCallCount: calls.length,
      toolDenialCount: calls.filter((c) => c.denied).length,
      bestPromptStyle: WorkerOptimizerService.promptStyle(logs),
      failureTypes: failures as never,
      strengths: WorkerOptimizerService.strengths(logs, calls.length),
      weaknesses: WorkerOptimizerService.weaknesses(logs, failures, calls),
      confidence: confidence.value,
      lastAnalyzedAt: new Date(),
    });

    await this.events.publish(DomainEvent.WorkerProfileUpdated, {
      workerId,
      executions: logs.length,
      successRate: profile.successRate,
      confidence: profile.confidence,
    });

    const count = await this.proposeFor(worker, profile, arms, best, calls);
    return { profile, recommendations: count };
  }

  async get(workerId: string): Promise<WorkerProfile | null> {
    return this.profiles.findForWorker(workerId);
  }

  async ranked(take = 25): Promise<WorkerProfile[]> {
    return this.profiles.ranked(take);
  }

  // ----------------------------------------------------------------
  // Proposals
  // ----------------------------------------------------------------

  private async proposeFor(
    worker: Worker,
    profile: WorkerProfile,
    arms: ProviderArm[],
    best: ProviderArm | null,
    calls: Array<{ tool: string; denied: boolean }>,
  ): Promise<number> {
    let proposed = 0;

    // 1. A different provider or model measurably outperforms the current one.
    if (best && best.providerId !== worker.providerId) {
      const current = arms.find((a) => a.providerId === worker.providerId);
      if (current && current.runs >= WorkerOptimizerService.MIN_ARM_RUNS) {
        const comparison = Confidence.comparisonConfidence(
          { successes: best.successes, trials: best.runs },
          { successes: current.successes, trials: current.runs },
        );

        const bestRate = best.successes / best.runs;
        const currentRate = current.successes / current.runs;
        const uplift = currentRate > 0 ? (bestRate - currentRate) / currentRate : bestRate;

        // Both conditions, not either: a difference that is real but tiny is
        // not worth a change, and one that is large but indistinguishable
        // from chance is not a difference.
        if (comparison.value > 0 && uplift >= WorkerOptimizerService.MIN_UPLIFT) {
          const provider = await this.providers.findById(best.providerId);
          await this.recommendations.propose({
            kind: RecommendationKind.PROVIDER_SWITCH,
            subject: MetricSubject.WORKER,
            subjectId: worker.id,
            subjectLabel: worker.name,
            title: `Move ${worker.name} to ${provider?.name ?? best.label}`,
            reasoning:
              `${worker.name} succeeds ${(bestRate * 100).toFixed(0)}% of the time on ` +
              `${best.label} (${best.runs} runs) against ${(currentRate * 100).toFixed(0)}% on ` +
              `${current.label} (${current.runs} runs). ${comparison.rationale}`,
            evidence: { arms, comparison },
            estimatedImpact: Math.min(1, uplift),
            impactSummary: `${(uplift * 100).toFixed(0)}% higher success rate`,
            risk: RecommendationService.riskFor(
              RecommendationKind.PROVIDER_SWITCH,
              comparison.value,
            ),
            proposedChange: {
              providerId: best.providerId,
              ...(best.model ? { defaultModel: best.model } : {}),
            },
            rollback: {
              providerId: worker.providerId,
              defaultModel: worker.defaultModel,
            },
            confidence: comparison.value,
            sampleSize: best.runs + current.runs,
          });
          proposed += 1;
        }
      }
    }

    // 2. The worker keeps asking for tools it is not allowed to use.
    const denied = calls.filter((c) => c.denied);
    if (denied.length >= 3) {
      const wanted = [...new Set(denied.map((c) => c.tool))].filter(
        (tool) => !worker.toolPermissions.includes(tool),
      );
      if (wanted.length > 0) {
        const confidence = Confidence.score({ samples: denied.length });
        await this.recommendations.propose({
          kind: RecommendationKind.TOOL_PERMISSION,
          subject: MetricSubject.WORKER,
          subjectId: worker.id,
          subjectLabel: worker.name,
          title: `Review tool access for ${worker.name}`,
          reasoning:
            `${worker.name} was denied ${denied.length} tool call(s) for ` +
            `${wanted.join(', ')}. Either it needs the access, or its instructions ` +
            'are telling it to reach for tools it should not use.',
          evidence: { denied: denied.length, tools: wanted },
          estimatedImpact: Math.min(0.5, denied.length / 20),
          impactSummary: `${denied.length} wasted call(s) per ${WorkerOptimizerService.WINDOW} executions`,
          // Granting tool access widens what an agent can do, so this is
          // never low-risk regardless of how confident the numbers are.
          risk: RecommendationService.riskFor(RecommendationKind.TOOL_PERMISSION, confidence.value),
          riskNotes: 'Granting a tool widens what this worker can do. Review the list.',
          proposedChange: { toolPermissions: [...worker.toolPermissions, ...wanted] },
          rollback: { toolPermissions: worker.toolPermissions },
          confidence: confidence.value,
          sampleSize: denied.length,
        });
        proposed += 1;
      }
    }

    // 3. Repeated retries suggest the iteration cap is too tight.
    const retryHeavy = profile.executions > 0 && profile.avgQuality < 0.6;
    if (retryHeavy && worker.maxIterations < 10 && profile.confidence >= 0.4) {
      await this.recommendations.propose({
        kind: RecommendationKind.LIMIT_ADJUSTMENT,
        subject: MetricSubject.WORKER,
        subjectId: worker.id,
        subjectLabel: worker.name,
        title: `Raise the iteration limit for ${worker.name}`,
        reasoning:
          `Only ${(profile.avgQuality * 100).toFixed(0)}% of this worker's executions ` +
          `succeed first time within ${worker.maxIterations} iterations. More room may ` +
          'let it finish rather than being cut off mid-task.',
        evidence: {
          avgQuality: profile.avgQuality,
          executions: profile.executions,
          maxIterations: worker.maxIterations,
        },
        estimatedImpact: Math.min(0.4, 0.6 - profile.avgQuality),
        impactSummary: 'fewer truncated executions',
        risk: RecommendationService.riskFor(
          RecommendationKind.LIMIT_ADJUSTMENT,
          profile.confidence,
        ),
        riskNotes: 'More iterations means more tokens and more cost per execution.',
        proposedChange: { maxIterations: Math.min(10, worker.maxIterations + 3) },
        rollback: { maxIterations: worker.maxIterations },
        confidence: profile.confidence,
        sampleSize: profile.executions,
      });
      proposed += 1;
    }

    // 4. No standing instructions at all is a gap worth naming.
    if (!worker.systemPrompt || worker.systemPrompt.trim().length < 20) {
      await this.recommendations.propose({
        kind: RecommendationKind.PROMPT_REFINEMENT,
        subject: MetricSubject.WORKER,
        subjectId: worker.id,
        subjectLabel: worker.name,
        title: `Give ${worker.name} standing instructions`,
        reasoning:
          `${worker.name} runs with ${worker.systemPrompt ? 'a very short' : 'no'} system ` +
          'prompt, so its behaviour depends entirely on each instruction it is given. ' +
          `Its role is "${worker.role}" and it has run ${profile.executions} time(s).`,
        evidence: {
          promptLength: worker.systemPrompt?.length ?? 0,
          role: worker.role,
          executions: profile.executions,
        },
        estimatedImpact: 0.3,
        impactSummary: 'more consistent behaviour across executions',
        // A prompt is what an agent is; the wording is a judgement, not a
        // number, so this stays with a person however sure the system is.
        risk: 'MEDIUM',
        riskNotes: 'Prompt wording is a judgement call. Draft it yourself.',
        proposedChange: {
          systemPrompt:
            `You are ${worker.name}, responsible for ${worker.role}. ` +
            `Work carefully and state your reasoning. Capabilities: ${worker.capabilities.join(', ') || 'general'}.`,
        },
        rollback: { systemPrompt: worker.systemPrompt },
        confidence: Confidence.score({ samples: Math.max(1, profile.executions) }).value,
        sampleSize: profile.executions,
      });
      proposed += 1;
    }

    return proposed;
  }

  // ----------------------------------------------------------------
  // Pure analysis
  // ----------------------------------------------------------------

  /** Groups execution history by the provider/model combination it ran on. */
  static armsFrom(logs: ExecutionLog[]): ProviderArm[] {
    const groups = new Map<string, ExecutionLog[]>();
    for (const log of logs) {
      if (!log.providerId) continue;
      const key = `${log.providerId}::${log.model ?? ''}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(log);
      else groups.set(key, [log]);
    }

    return [...groups.entries()].map(([key, group]) => {
      const [providerId, model] = key.split('::');
      const successes = group.filter((l) => l.status === 'SUCCEEDED').length;
      return {
        providerId,
        model: model || null,
        label: model ? `${group[0].providerKind ?? providerId}/${model}` : providerId,
        runs: group.length,
        successes,
        avgCostUsd: Number(
          (group.reduce((s, l) => s + l.costUsd, 0) / group.length).toFixed(6),
        ),
        avgLatencyMs: Number(
          (group.reduce((s, l) => s + l.latencyMs, 0) / group.length).toFixed(2),
        ),
      };
    });
  }

  /**
   * The arm with the best *lower bound* on its success rate.
   *
   * Not the best observed rate: a 3-for-3 arm observes 100% and would beat a
   * 480-for-500 arm, which is how a worker gets moved onto a provider it has
   * barely used on the strength of a lucky afternoon.
   */
  static bestArm(arms: ProviderArm[]): ProviderArm | null {
    const eligible = arms.filter((a) => a.runs >= WorkerOptimizerService.MIN_ARM_RUNS);
    if (eligible.length === 0) return null;

    return eligible.reduce((best, arm) => {
      const armScore = Confidence.wilsonLowerBound(arm.successes, arm.runs);
      const bestScore = Confidence.wilsonLowerBound(best.successes, best.runs);
      if (armScore !== bestScore) return armScore > bestScore ? arm : best;
      // Equal reliability: prefer the cheaper one, then the faster one.
      if (arm.avgCostUsd !== best.avgCostUsd) return arm.avgCostUsd < best.avgCostUsd ? arm : best;
      return arm.avgLatencyMs < best.avgLatencyMs ? arm : best;
    });
  }

  static qualityOf(logs: ExecutionLog[]): number {
    if (logs.length === 0) return 0;
    const clean = logs.filter((l) => l.status === 'SUCCEEDED' && l.attempts <= 1).length;
    return Number((clean / logs.length).toFixed(4));
  }

  static failureTypes(logs: ExecutionLog[]): Array<{ signature: string; count: number }> {
    const counts = new Map<string, number>();
    for (const log of logs) {
      if (!log.error) continue;
      const signature = MissionReviewService.errorSignature(log.error);
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([signature, count]) => ({ signature, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  /**
   * Which prompt length band correlated with the best outcomes.
   *
   * Correlation, and labelled as such — the bands are crude and the sample
   * is whatever the worker happened to be sent. It is a hint for a human
   * writing the next prompt, not a finding.
   */
  static promptStyle(logs: ExecutionLog[]): string | null {
    const withPrompts = logs.filter((l) => l.prompt && l.prompt.length > 0);
    if (withPrompts.length < WorkerOptimizerService.MIN_ARM_RUNS) return null;

    const bands = [
      { name: 'concise (<500 chars)', min: 0, max: 500 },
      { name: 'moderate (500-2000 chars)', min: 500, max: 2000 },
      { name: 'detailed (>2000 chars)', min: 2000, max: Number.MAX_SAFE_INTEGER },
    ];

    let best: { name: string; rate: number; n: number } | null = null;
    for (const band of bands) {
      const inBand = withPrompts.filter(
        (l) => l.prompt!.length >= band.min && l.prompt!.length < band.max,
      );
      if (inBand.length < 3) continue;
      const successes = inBand.filter((l) => l.status === 'SUCCEEDED').length;
      const rate = Confidence.wilsonLowerBound(successes, inBand.length);
      if (!best || rate > best.rate) best = { name: band.name, rate, n: inBand.length };
    }

    return best ? `${best.name} — ${(best.rate * 100).toFixed(0)}% over ${best.n} runs` : null;
  }

  static strengths(logs: ExecutionLog[], toolCalls: number): string[] {
    const strengths: string[] = [];
    const successes = logs.filter((l) => l.status === 'SUCCEEDED').length;
    const rate = Confidence.wilsonLowerBound(successes, logs.length);

    if (rate >= 0.8) strengths.push(`reliable (${(rate * 100).toFixed(0)}% floor on success rate)`);

    const firstTime = logs.filter((l) => l.status === 'SUCCEEDED' && l.attempts <= 1).length;
    if (logs.length > 0 && firstTime / logs.length >= 0.8) {
      strengths.push('rarely needs a retry');
    }

    const latencies = logs.map((l) => l.latencyMs).filter((n) => n > 0);
    if (latencies.length > 0 && mean(latencies) < 5_000) strengths.push('fast');

    const costs = logs.map((l) => l.costUsd);
    if (costs.length > 0 && mean(costs) < 0.01) strengths.push('cheap to run');

    if (toolCalls > logs.length) strengths.push('makes active use of its tools');

    return strengths;
  }

  static weaknesses(
    logs: ExecutionLog[],
    failures: Array<{ signature: string; count: number }>,
    calls: Array<{ denied: boolean }>,
  ): string[] {
    const weaknesses: string[] = [];
    const successes = logs.filter((l) => l.status === 'SUCCEEDED').length;
    const rate = Confidence.wilsonLowerBound(successes, logs.length);

    if (rate < 0.5) weaknesses.push(`unreliable (${(rate * 100).toFixed(0)}% floor on success rate)`);

    const retried = logs.filter((l) => l.attempts > 1).length;
    if (logs.length > 0 && retried / logs.length > 0.25) {
      weaknesses.push(`retries often (${retried}/${logs.length} executions)`);
    }

    if (failures[0] && failures[0].count >= 3) {
      weaknesses.push(`recurring failure: ${failures[0].signature.slice(0, 80)}`);
    }

    const denied = calls.filter((c) => c.denied).length;
    if (denied >= 3) weaknesses.push(`reaches for tools it lacks access to (${denied} times)`);

    const latencies = logs.map((l) => l.latencyMs).filter((n) => n > 0);
    if (latencies.length > 0 && mean(latencies) > 30_000) weaknesses.push('slow');

    return weaknesses;
  }

  /** Days since the oldest execution in the window, for recency weighting. */
  static ageDays(logs: ExecutionLog[]): number {
    if (logs.length === 0) return 0;
    const newest = Math.max(...logs.map((l) => l.startedAt.getTime()));
    return Math.max(0, (Date.now() - newest) / 86_400_000);
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
