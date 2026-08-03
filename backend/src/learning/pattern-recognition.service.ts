import { Injectable, Logger } from '@nestjs/common';
import { DetectedPattern, MissionReview, PatternKind, Task } from '@prisma/client';
import { createHash } from 'node:crypto';
import { DetectedPatternRepository } from '../database/repositories/learning.repositories';
import { MissionReviewRepository } from '../database/repositories/learning.repositories';
import { ExecutionLogRepository } from '../database/repositories/execution.repositories';
import { TaskRepository } from '../database/repositories/tenant.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import * as Confidence from './confidence';

export interface PatternCandidate {
  kind: PatternKind;
  signature: string;
  statement: string;
  detail: Record<string, unknown>;
  evidenceIds: string[];
  occurrences: number;
  contradictions: number;
}

/**
 * Finds regularities across missions, and refuses to overstate them.
 *
 * The hard part of pattern detection is not spotting repetition — it is not
 * announcing a discovery every time two things happen twice. Three defences:
 *
 *  1. A candidate needs a minimum number of occurrences before it is
 *     recorded at all.
 *  2. Contradictions are counted alongside occurrences, so a "pattern" that
 *     holds eight times and fails seven is visibly not one.
 *  3. Every pattern carries a confidence band, and the band is what the
 *     interface leads with. An ANECDOTAL pattern reads as a question.
 *
 * Patterns are keyed on a stable signature and reinforced in place, so
 * something seen fifty times is one row with a count rather than fifty rows
 * that each look like a separate discovery.
 */
@Injectable()
export class PatternRecognitionService {
  private readonly logger = new Logger(PatternRecognitionService.name);

  /** Sightings before a candidate is worth recording. */
  static readonly MIN_OCCURRENCES = 3;
  /** Reviews to scan in one pass. */
  static readonly WINDOW = 300;

  constructor(
    private readonly patterns: DetectedPatternRepository,
    private readonly reviews: MissionReviewRepository,
    private readonly executionLogs: ExecutionLogRepository,
    private readonly tasks: TaskRepository,
    private readonly events: EventBusService,
  ) {}

  /** Scans recent history and records what recurs. */
  async detect(): Promise<{ scanned: number; found: number; patterns: DetectedPattern[] }> {
    const reviews = await this.reviews.recent(PatternRecognitionService.WINDOW);

    if (reviews.length < PatternRecognitionService.MIN_OCCURRENCES) {
      return { scanned: reviews.length, found: 0, patterns: [] };
    }

    const candidates: PatternCandidate[] = [
      ...PatternRecognitionService.failureModes(reviews),
      ...PatternRecognitionService.timingPatterns(reviews),
      ...PatternRecognitionService.costPatterns(reviews),
      ...PatternRecognitionService.roiPatterns(reviews),
      ...(await this.providerAffinity()),
      ...(await this.collaborationPatterns(reviews)),
    ];

    const recorded: DetectedPattern[] = [];
    for (const candidate of candidates) {
      if (candidate.occurrences < PatternRecognitionService.MIN_OCCURRENCES) continue;

      // Contradictions cut confidence directly: a regularity that fails
      // often is not a weak pattern, it is a wrong one.
      const total = candidate.occurrences + candidate.contradictions;
      const consistency = total > 0 ? candidate.occurrences / total : 0;

      const confidence = Confidence.score({
        samples: candidate.occurrences,
        consistency,
      });

      const existed = await this.patterns.findMany({ signature: candidate.signature });
      const pattern = await this.patterns.observe({
        ...candidate,
        confidence: confidence.value,
        band: confidence.band,
      });

      await this.events.publish(
        existed.length > 0 ? DomainEvent.PatternReinforced : DomainEvent.PatternDetected,
        {
          patternId: pattern.id,
          kind: pattern.kind,
          occurrences: pattern.occurrences,
          confidence: pattern.confidence,
          band: pattern.band,
        },
      );

      recorded.push(pattern);
    }

    return { scanned: reviews.length, found: recorded.length, patterns: recorded };
  }

  async list(take = 50): Promise<DetectedPattern[]> {
    return this.patterns.active(take);
  }

  /**
   * Marks a pattern wrong.
   *
   * Kept rather than deleted: a human saying "that is not a real pattern" is
   * itself evidence, and a detector that can re-propose a dismissed
   * regularity next week has learned nothing.
   */
  async dismiss(id: string, reason: string): Promise<DetectedPattern> {
    const dismissed = await this.patterns.update(id, {
      dismissedAt: new Date(),
      dismissedReason: reason,
    });
    await this.events.publish(DomainEvent.PatternDismissed, { patternId: id, reason });
    return dismissed;
  }

  // ----------------------------------------------------------------
  // Detectors — pure where they can be
  // ----------------------------------------------------------------

  /** The same error signature across several unrelated missions. */
  static failureModes(reviews: MissionReview[]): PatternCandidate[] {
    const byError = new Map<string, MissionReview[]>();
    for (const review of reviews) {
      for (const error of review.errors) {
        const bucket = byError.get(error);
        if (bucket) bucket.push(review);
        else byError.set(error, [review]);
      }
    }

    return [...byError.entries()]
      .filter(([, group]) => group.length >= PatternRecognitionService.MIN_OCCURRENCES)
      .map(([error, group]) => ({
        kind: PatternKind.FAILURE_MODE,
        signature: PatternRecognitionService.signature('failure', error),
        statement:
          `"${error.slice(0, 120)}" has occurred in ${group.length} missions. ` +
          'It is a recurring fault, not an isolated incident.',
        detail: {
          error,
          missions: group.length,
          // The share of affected missions that failed outright tells you
          // whether this fault is fatal or merely noisy.
          fatalShare: Number(
            (group.filter((r) => r.outcome === 'FAILURE').length / group.length).toFixed(4),
          ),
        },
        evidenceIds: group.map((r) => r.missionId).slice(0, 20),
        occurrences: group.length,
        contradictions: 0,
      }));
  }

  /**
   * Missions that consistently overrun their estimate.
   *
   * Contradictions are the missions that came in on time: without counting
   * them, "sometimes slow" would read exactly like "always slow".
   */
  static timingPatterns(reviews: MissionReview[]): PatternCandidate[] {
    const withEstimates = reviews.filter((r) => r.estimatedMs && r.estimatedMs > 0);
    if (withEstimates.length < PatternRecognitionService.MIN_OCCURRENCES) return [];

    const overran = withEstimates.filter((r) => r.completionMs > r.estimatedMs! * 1.5);
    const onTime = withEstimates.length - overran.length;

    if (overran.length < PatternRecognitionService.MIN_OCCURRENCES) return [];

    const factor =
      overran.reduce((sum, r) => sum + r.completionMs / r.estimatedMs!, 0) / overran.length;

    return [
      {
        kind: PatternKind.TIMING,
        signature: PatternRecognitionService.signature('timing', 'estimate-drift'),
        statement:
          `Missions run about ${factor.toFixed(1)}× their planned duration ` +
          `(${overran.length} of ${withEstimates.length} overran by more than half).`,
        detail: { averageFactor: Number(factor.toFixed(2)), overran: overran.length, onTime },
        evidenceIds: overran.map((r) => r.missionId).slice(0, 20),
        occurrences: overran.length,
        contradictions: onTime,
      },
    ];
  }

  static costPatterns(reviews: MissionReview[]): PatternCandidate[] {
    const withEstimates = reviews.filter((r) => r.estimatedCostUsd && r.estimatedCostUsd > 0);
    if (withEstimates.length < PatternRecognitionService.MIN_OCCURRENCES) return [];

    const over = withEstimates.filter((r) => r.costUsd > r.estimatedCostUsd! * 1.5);
    if (over.length < PatternRecognitionService.MIN_OCCURRENCES) return [];

    const excess = over.reduce((sum, r) => sum + (r.costUsd - r.estimatedCostUsd!), 0);

    return [
      {
        kind: PatternKind.COST,
        signature: PatternRecognitionService.signature('cost', 'budget-overrun'),
        statement:
          `${over.length} of ${withEstimates.length} missions exceeded their cost estimate, ` +
          `by $${excess.toFixed(4)} in total.`,
        detail: {
          overran: over.length,
          withinBudget: withEstimates.length - over.length,
          excessUsd: Number(excess.toFixed(6)),
        },
        evidenceIds: over.map((r) => r.missionId).slice(0, 20),
        occurrences: over.length,
        contradictions: withEstimates.length - over.length,
      },
    ];
  }

  /**
   * Which kinds of objective actually pay off.
   *
   * Grouped by the leading words of the objective — a crude proxy for
   * "similar work", and labelled as such in the statement so nobody reads
   * more precision into it than is there.
   */
  static roiPatterns(reviews: MissionReview[]): PatternCandidate[] {
    const byTheme = new Map<string, MissionReview[]>();

    for (const review of reviews) {
      const theme = PatternRecognitionService.themeOf(review.objective);
      if (!theme) continue;
      const bucket = byTheme.get(theme);
      if (bucket) bucket.push(review);
      else byTheme.set(theme, [review]);
    }

    const candidates: PatternCandidate[] = [];
    for (const [theme, group] of byTheme) {
      if (group.length < PatternRecognitionService.MIN_OCCURRENCES) continue;

      const successes = group.filter((r) => r.outcome === 'SUCCESS').length;
      const rate = Confidence.wilsonLowerBound(successes, group.length);
      const avgCost = group.reduce((s, r) => s + r.costUsd, 0) / group.length;

      // Only worth stating when it is notably good or notably bad; a theme
      // that performs exactly averagely is not a finding.
      if (rate < 0.75 && rate > 0.35) continue;

      candidates.push({
        kind: PatternKind.ROI,
        signature: PatternRecognitionService.signature('roi', theme),
        statement:
          `Missions about "${theme}" succeed ${(rate * 100).toFixed(0)}% of the time ` +
          `(lower bound over ${group.length} missions) at $${avgCost.toFixed(4)} each.`,
        detail: {
          theme,
          missions: group.length,
          successes,
          successRateLowerBound: rate,
          avgCostUsd: Number(avgCost.toFixed(6)),
          verdict: rate >= 0.75 ? 'reliably worthwhile' : 'frequently disappointing',
        },
        evidenceIds: group.map((r) => r.missionId).slice(0, 20),
        occurrences: group.length,
        contradictions: rate >= 0.75 ? group.length - successes : successes,
      });
    }

    return candidates;
  }

  /** Which provider is actually better for which kind of work. */
  private async providerAffinity(): Promise<PatternCandidate[]> {
    const logs = await this.executionLogs.findMany(
      {},
      { take: 2000, orderBy: { startedAt: 'desc' } },
    );

    const byProvider = new Map<string, { runs: number; successes: number; kind: string }>();
    for (const log of logs) {
      if (!log.providerId) continue;
      const entry = byProvider.get(log.providerId) ?? {
        runs: 0,
        successes: 0,
        kind: String(log.providerKind ?? 'unknown'),
      };
      entry.runs += 1;
      if (log.status === 'SUCCEEDED') entry.successes += 1;
      byProvider.set(log.providerId, entry);
    }

    const arms = [...byProvider.entries()].filter(([, v]) => v.runs >= 10);
    if (arms.length < 2) return [];

    const ranked = arms.sort(
      (a, b) =>
        Confidence.wilsonLowerBound(b[1].successes, b[1].runs) -
        Confidence.wilsonLowerBound(a[1].successes, a[1].runs),
    );

    const [bestId, best] = ranked[0];
    const [worstId, worst] = ranked[ranked.length - 1];

    // Only a pattern if the two genuinely separate. Otherwise this is just
    // the ordering of two numbers that happen to differ.
    const comparison = Confidence.comparisonConfidence(
      { successes: best.successes, trials: best.runs },
      { successes: worst.successes, trials: worst.runs },
    );
    if (comparison.value === 0) return [];

    return [
      {
        kind: PatternKind.PROVIDER_AFFINITY,
        signature: PatternRecognitionService.signature('provider', `${bestId}>${worstId}`),
        statement:
          `${best.kind} outperforms ${worst.kind} on this workload: ` +
          `${((best.successes / best.runs) * 100).toFixed(0)}% over ${best.runs} calls ` +
          `against ${((worst.successes / worst.runs) * 100).toFixed(0)}% over ${worst.runs}.`,
        detail: { best: { id: bestId, ...best }, worst: { id: worstId, ...worst } },
        evidenceIds: [bestId, worstId],
        occurrences: best.runs + worst.runs,
        contradictions: 0,
      },
    ];
  }

  /** Workers that keep appearing together in missions that go well. */
  private async collaborationPatterns(reviews: MissionReview[]): Promise<PatternCandidate[]> {
    const successful = reviews.filter((r) => r.outcome === 'SUCCESS').slice(0, 100);
    if (successful.length < PatternRecognitionService.MIN_OCCURRENCES) return [];

    const pairCounts = new Map<string, { count: number; missions: string[] }>();

    for (const review of successful) {
      const tasks = await this.tasks.findByMission(review.missionId);
      const workers = [...new Set(tasks.map((t: Task) => t.workerId).filter(Boolean))].sort();

      for (let i = 0; i < workers.length; i += 1) {
        for (let j = i + 1; j < workers.length; j += 1) {
          const key = `${workers[i]}+${workers[j]}`;
          const entry = pairCounts.get(key) ?? { count: 0, missions: [] };
          entry.count += 1;
          entry.missions.push(review.missionId);
          pairCounts.set(key, entry);
        }
      }
    }

    return [...pairCounts.entries()]
      .filter(([, v]) => v.count >= PatternRecognitionService.MIN_OCCURRENCES)
      .map(([pair, v]) => ({
        kind: PatternKind.WORKER_COLLABORATION,
        signature: PatternRecognitionService.signature('collab', pair),
        statement:
          `Workers ${pair.replace('+', ' and ')} have appeared together in ` +
          `${v.count} successful missions.`,
        detail: { pair: pair.split('+'), successfulMissions: v.count },
        evidenceIds: v.missions.slice(0, 20),
        occurrences: v.count,
        contradictions: 0,
      }));
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  /** Stable id for a regularity, so repeat sightings reinforce one row. */
  static signature(kind: string, value: string): string {
    return `${kind}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
  }

  /**
   * A crude theme for an objective: its first two meaningful words.
   *
   * Deliberately simple. Anything cleverer would need an embedding model,
   * which would make pattern detection depend on a provider being reachable
   * — and a learning engine that stops learning when an API key expires is
   * worse than one that groups approximately.
   */
  static themeOf(objective: string): string | null {
    const words = objective
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !THEME_STOP_WORDS.has(w));
    if (words.length === 0) return null;
    return words.slice(0, 2).join(' ');
  }

  asOrganization<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return RequestContextStore.run(
      {
        userId: 'system',
        organizationId,
        roleKey: 'SYSTEM',
        permissions: ['*'],
        requestId: `patterns-${Date.now()}`,
      },
      fn,
    );
  }
}

const THEME_STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'will', 'about', 'into', 'when',
  'what', 'which', 'their', 'there', 'then', 'than', 'been', 'were', 'also',
  'each', 'more', 'some', 'such', 'only', 'other', 'these', 'those', 'make',
  'using', 'based', 'across', 'every',
]);
