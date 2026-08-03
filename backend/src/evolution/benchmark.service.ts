import { Injectable, Logger } from '@nestjs/common';
import { Benchmark, BenchmarkVerdict } from '@prisma/client';
import { BenchmarkRepository } from '../database/repositories/evolution.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import * as Confidence from '../learning/confidence';

/** One measured attempt on one arm. */
export interface Trial {
  succeeded: boolean;
  completionMs: number;
  costUsd: number;
  tokens: number;
  latencyMs: number;
  /** True when the attempt needed a retry to succeed. */
  retried?: boolean;
  /** 1–5, when a human rated it. */
  rating?: number;
  /** 0..1 automated quality signal, when there is one. */
  quality?: number;
}

export interface MetricComparison {
  metric: string;
  control: number;
  variant: number;
  /** Relative change, variant against control. */
  delta: number;
  /** True when a *higher* number is better for this metric. */
  higherIsBetter: boolean;
  /** Whether the variant is better on this metric alone. */
  favoursVariant: boolean;
  /** Whether the difference is large enough to be worth mentioning. */
  material: boolean;
}

export interface ComparisonResult {
  verdict: BenchmarkVerdict;
  winner: 'control' | 'variant' | null;
  confidence: number;
  /** One sentence a human can act on. */
  summary: string;
  metrics: MetricComparison[];
  /** Metrics where the variant is worse, even if it won overall. */
  regressions: MetricComparison[];
}

/**
 * Measures two versions against each other, and refuses to guess.
 *
 * Nine metrics are recorded per arm rather than collapsed into one score,
 * because collapsing early hides the trade-offs that make a decision worth
 * making: a variant that is faster and worse is a completely different
 * situation from one that is faster and cheaper, and a single number reports
 * them identically.
 *
 * The verdict is decided by reliability first and everything else second.
 * That ordering is a claim: a change that makes the system cheaper and
 * quicker while succeeding less often has not improved it. Cost and speed
 * are how well the work is done; success rate is whether it was done.
 */
@Injectable()
export class BenchmarkService {
  private readonly logger = new Logger(BenchmarkService.name);

  /** Relative change below which a difference is treated as noise. */
  static readonly MATERIAL_DELTA = 0.05;
  /** Trials an arm needs before its numbers mean anything at all. */
  static readonly MIN_TRIALS = 5;

  /** Which direction is good, per metric. */
  static readonly HIGHER_IS_BETTER: Record<string, boolean> = {
    successRate: true,
    reliability: true,
    qualityScore: true,
    userRating: true,
    roi: true,
    avgCompletionMs: false,
    avgCostUsd: false,
    avgTokens: false,
    avgLatencyMs: false,
  };

  constructor(
    private readonly benchmarks: BenchmarkRepository,
    private readonly events: EventBusService,
  ) {}

  /** Computes and stores an arm's measurements from its raw trials. */
  async record(
    experimentId: string,
    arm: 'control' | 'variant',
    trials: Trial[],
  ): Promise<Benchmark> {
    const metrics = BenchmarkService.measure(trials);
    const benchmark = await this.benchmarks.record(experimentId, arm, metrics);

    await this.events.publish(DomainEvent.EvolutionBenchmarkRecorded, {
      experimentId,
      arm,
      trials: trials.length,
      successRate: benchmark.successRate,
    });

    return benchmark;
  }

  async forExperiment(experimentId: string): Promise<Benchmark[]> {
    return this.benchmarks.forExperiment(experimentId);
  }

  /** Compares the two stored arms of an experiment. */
  async compare(experimentId: string, minTrials?: number): Promise<ComparisonResult> {
    const arms = await this.benchmarks.forExperiment(experimentId);
    const control = arms.find((a) => a.arm === 'control');
    const variant = arms.find((a) => a.arm === 'variant');

    if (!control || !variant) {
      return {
        verdict: BenchmarkVerdict.INSUFFICIENT_DATA,
        winner: null,
        confidence: 0,
        summary: 'Both arms must be benchmarked before they can be compared.',
        metrics: [],
        regressions: [],
      };
    }

    return BenchmarkService.judge(control, variant, minTrials ?? BenchmarkService.MIN_TRIALS);
  }

  // ----------------------------------------------------------------
  // Pure measurement
  // ----------------------------------------------------------------

  /** Turns raw trials into the nine metrics. */
  static measure(trials: Trial[]): Record<string, unknown> {
    const count = trials.length;
    if (count === 0) {
      return {
        trials: 0, successes: 0, successRate: 0, observedRate: 0,
        avgCompletionMs: 0, p95CompletionMs: 0, qualityScore: 0,
        avgCostUsd: 0, totalCostUsd: 0, avgTokens: 0, avgLatencyMs: 0,
        reliability: 0, userRating: null, ratingCount: 0, roi: 0,
      };
    }

    const successes = trials.filter((t) => t.succeeded).length;
    const completions = trials.map((t) => t.completionMs).filter((n) => n > 0);
    const totalCostUsd = Number(trials.reduce((s, t) => s + t.costUsd, 0).toFixed(6));

    // Reliability is stricter than success rate: succeeding on the second
    // attempt is a success but not a reliable one, and a change that trades
    // reliability for eventual success is worth seeing separately.
    const clean = trials.filter((t) => t.succeeded && !t.retried).length;

    const rated = trials.filter((t) => typeof t.rating === 'number');
    const qualities = trials.map((t) => t.quality).filter((q): q is number => typeof q === 'number');

    return {
      trials: count,
      successes,
      successRate: Confidence.wilsonLowerBound(successes, count),
      observedRate: Number((successes / count).toFixed(4)),
      avgCompletionMs: BenchmarkService.mean(completions),
      p95CompletionMs: BenchmarkService.percentile(completions, 0.95),
      // Falls back to the clean-success rate when nothing measured quality
      // directly, rather than reporting zero — which would read as "the
      // output was worthless" instead of "nobody assessed it".
      qualityScore:
        qualities.length > 0
          ? Number(BenchmarkService.mean(qualities).toFixed(4))
          : Number((clean / count).toFixed(4)),
      avgCostUsd: Number((totalCostUsd / count).toFixed(6)),
      totalCostUsd,
      avgTokens: BenchmarkService.mean(trials.map((t) => t.tokens)),
      avgLatencyMs: BenchmarkService.mean(trials.map((t) => t.latencyMs)),
      reliability: Number((clean / count).toFixed(4)),
      // Null, not zero: an unrated arm has no rating, and averaging it as
      // zero would make rating something a variant is punished for lacking.
      userRating:
        rated.length > 0
          ? Number(
              (rated.reduce((s, t) => s + (t.rating ?? 0), 0) / rated.length).toFixed(3),
            )
          : null,
      ratingCount: rated.length,
      roi: totalCostUsd > 0 ? Number((successes / totalCostUsd).toFixed(4)) : 0,
    };
  }

  /**
   * The verdict.
   *
   * Two gates before any comparison is attempted: enough trials on both
   * arms, and success rates that actually separate. Both exist because the
   * expensive mistake here is not missing an improvement — it is deploying
   * a change on the strength of a difference that was never there.
   */
  static judge(
    control: Benchmark,
    variant: Benchmark,
    minTrials = BenchmarkService.MIN_TRIALS,
  ): ComparisonResult {
    const metrics = BenchmarkService.compareMetrics(control, variant);
    const regressions = metrics.filter((m) => m.material && !m.favoursVariant);

    if (control.trials < minTrials || variant.trials < minTrials) {
      return {
        verdict: BenchmarkVerdict.INSUFFICIENT_DATA,
        winner: null,
        confidence: 0,
        summary:
          `Not enough trials: control ${control.trials}/${minTrials}, ` +
          `variant ${variant.trials}/${minTrials}.`,
        metrics,
        regressions,
      };
    }

    const separation = Confidence.comparisonConfidence(
      { successes: variant.successes, trials: variant.trials },
      { successes: control.successes, trials: control.trials },
    );

    if (separation.value === 0) {
      // The arms cannot be told apart on reliability. A secondary metric
      // may still justify the change — a variant that is materially cheaper
      // at the same success rate is a real improvement — but it is reported
      // as such rather than dressed up as a reliability win.
      const cheaper = metrics.find((m) => m.metric === 'avgCostUsd');
      const faster = metrics.find((m) => m.metric === 'avgCompletionMs');
      const secondary = [cheaper, faster].filter(
        (m): m is MetricComparison => Boolean(m?.material && m?.favoursVariant),
      );

      if (secondary.length > 0 && regressions.length === 0) {
        const evidence = Confidence.score({
          samples: control.trials + variant.trials,
          consistency: 0.7,
        });
        return {
          verdict: BenchmarkVerdict.BETTER,
          winner: 'variant',
          confidence: evidence.value,
          summary:
            `Equally reliable, but better on ${secondary.map((m) => m.metric).join(' and ')}: ` +
            secondary
              .map((m) => `${m.metric} ${(m.delta * 100).toFixed(0)}%`)
              .join(', ') +
            `. ${evidence.rationale}`,
          metrics,
          regressions,
        };
      }

      return {
        verdict: BenchmarkVerdict.INCONCLUSIVE,
        winner: null,
        confidence: 0,
        summary: `No measurable difference. ${separation.rationale}`,
        metrics,
        regressions,
      };
    }

    const variantBetter = variant.successRate > control.successRate;

    return {
      verdict: variantBetter ? BenchmarkVerdict.BETTER : BenchmarkVerdict.WORSE,
      winner: variantBetter ? 'variant' : 'control',
      confidence: separation.value,
      summary:
        `${variantBetter ? 'Variant' : 'Control'} is more reliable: ` +
        `${(Math.max(variant.successRate, control.successRate) * 100).toFixed(1)}% against ` +
        `${(Math.min(variant.successRate, control.successRate) * 100).toFixed(1)}% ` +
        `(lower bounds over ${control.trials + variant.trials} trials)` +
        (variantBetter && regressions.length > 0
          ? `, but it regresses on ${regressions.map((r) => r.metric).join(', ')}`
          : '') +
        `. ${separation.rationale}`,
      metrics,
      regressions,
    };
  }

  static compareMetrics(control: Benchmark, variant: Benchmark): MetricComparison[] {
    return Object.entries(BenchmarkService.HIGHER_IS_BETTER).map(([metric, higherIsBetter]) => {
      const controlValue = Number((control as unknown as Record<string, unknown>)[metric] ?? 0);
      const variantValue = Number((variant as unknown as Record<string, unknown>)[metric] ?? 0);

      const delta = BenchmarkService.relativeChange(controlValue, variantValue);
      const favoursVariant = higherIsBetter ? variantValue > controlValue : variantValue < controlValue;

      return {
        metric,
        control: controlValue,
        variant: variantValue,
        delta,
        higherIsBetter,
        favoursVariant,
        material: Math.abs(delta) >= BenchmarkService.MATERIAL_DELTA,
      };
    });
  }

  /**
   * Relative change from `from` to `to`.
   *
   * A change from zero is reported as zero rather than as infinity: going
   * from no cost to some cost is meaningful, but "infinitely worse" is not a
   * number anyone can rank against, and it would dominate every comparison
   * it appeared in.
   */
  static relativeChange(from: number, to: number): number {
    if (from === 0) return to === 0 ? 0 : 0;
    return Number(((to - from) / Math.abs(from)).toFixed(4));
  }

  static mean(values: number[]): number {
    if (values.length === 0) return 0;
    return Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(2));
  }

  static percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    // Nearest-rank, so a reported percentile is a value that was actually
    // observed rather than one interpolated between two that were.
    const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
    return Number(sorted[Math.max(0, index)].toFixed(2));
  }
}
