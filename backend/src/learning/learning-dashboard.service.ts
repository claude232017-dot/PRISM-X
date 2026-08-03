import { Injectable, Logger } from '@nestjs/common';
import {
  LearningEntry,
  LearningEntryKind,
  MetricPeriod,
  MetricSubject,
} from '@prisma/client';
import {
  DetectedPatternRepository,
  ExperimentRepository,
  KnowledgeAuditRepository,
  LearningEntryRepository,
  MissionReviewRepository,
  RecommendationRepository,
  WorkerProfileRepository,
} from '../database/repositories/learning.repositories';
import { KnowledgeRepository } from '../database/repositories/tenant.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { PerformanceAnalyticsService } from './performance-analytics.service';
import * as Confidence from './confidence';

export interface LearningDigest {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  /** The one-line answer to "what has PRISM-X learned this week?" */
  headline: string;
  learned: string[];
  missions: {
    reviewed: number;
    succeeded: number;
    partial: number;
    failed: number;
    avgSuccessScore: number;
    avgCostUsd: number;
    totalCostUsd: number;
  };
  topWorkers: Array<{ label: string; successRate: number; executions: number; confidence: number }>;
  topProviders: Array<{ label: string; successRate: number; samples: number; avgLatencyMs: number }>;
  fastestMissions: Array<{ objective: string; completionMs: number; successScore: number }>;
  reliableWorkflows: Array<{ label: string; successRate: number; samples: number }>;
  knowledge: {
    documents: number;
    openFindings: number;
    avgConfidence: number;
    growth: number;
  };
  opportunities: Array<{
    id: string;
    title: string;
    impactSummary: string;
    priority: number;
    confidence: number;
    band: string;
  }>;
  patterns: Array<{ statement: string; occurrences: number; confidence: number; band: string }>;
  experiments: Array<{ name: string; status: string; winner: string | null; confidence: number }>;
  improvement: {
    successRateChange: number;
    costChange: number;
    direction: 'improving' | 'declining' | 'steady' | 'unknown';
    summary: string;
  };
}

/**
 * The one screen that answers "what has PRISM-X learned this week?"
 *
 * Everything here is assembled from what the other services already
 * computed. The dashboard deliberately derives nothing of its own: a
 * dashboard that recalculates its own success rates is a dashboard that can
 * disagree with the engine it is reporting on, and then nobody knows which
 * number is real.
 *
 * The headline and the `learned` list are the point. A wall of metrics tells
 * you the system is measuring; a sentence naming what changed tells you it
 * is learning — and if that list comes back empty, the honest answer is that
 * nothing was learned this week, not a page of charts implying otherwise.
 */
@Injectable()
export class LearningDashboardService {
  private readonly logger = new Logger(LearningDashboardService.name);

  constructor(
    private readonly reviews: MissionReviewRepository,
    private readonly recommendations: RecommendationRepository,
    private readonly patterns: DetectedPatternRepository,
    private readonly profiles: WorkerProfileRepository,
    private readonly entries: LearningEntryRepository,
    private readonly audits: KnowledgeAuditRepository,
    private readonly experiments: ExperimentRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly analytics: PerformanceAnalyticsService,
    private readonly events: EventBusService,
  ) {}

  async digest(days = 7): Promise<LearningDigest> {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const previousFrom = new Date(from.getTime() - days * 86_400_000);

    const [
      reviews,
      previousReviews,
      openRecommendations,
      patterns,
      profiles,
      documents,
      openFindings,
      experiments,
      workerBoard,
      providerBoard,
      workflowBoard,
    ] = await Promise.all([
      this.reviews.since(from),
      this.reviews.findMany(
        { createdAt: { gte: previousFrom, lt: from } },
        { take: 500 },
      ),
      this.recommendations.open(10),
      this.patterns.active(10),
      this.profiles.ranked(10),
      this.knowledge.findMany({}, { take: 1000 }),
      this.audits.unresolved(500),
      this.experiments.findMany({}, { take: 10, orderBy: { startedAt: 'desc' } }),
      this.analytics.leaderboard(MetricSubject.WORKER, MetricPeriod.DAY, 5),
      this.analytics.leaderboard(MetricSubject.PROVIDER, MetricPeriod.DAY, 5),
      this.analytics.leaderboard(MetricSubject.WORKFLOW, MetricPeriod.DAY, 5),
    ]);

    const missions = LearningDashboardService.missionStats(reviews);
    const previous = LearningDashboardService.missionStats(previousReviews);

    const newDocuments = documents.filter((d) => d.createdAt >= from).length;
    const avgKnowledgeConfidence =
      documents.length > 0
        ? Number(
            (documents.reduce((s, d) => s + d.confidence, 0) / documents.length).toFixed(4),
          )
        : 0;

    const improvement = LearningDashboardService.compare(missions, previous, days);

    const learned = LearningDashboardService.whatWasLearned({
      reviews: reviews.length,
      patterns,
      recommendations: openRecommendations,
      experiments,
      newDocuments,
      openFindings: openFindings.length,
      improvement,
    });

    return {
      generatedAt: to.toISOString(),
      window: { from: from.toISOString(), to: to.toISOString(), days },
      headline: LearningDashboardService.headline(learned, missions, improvement),
      learned,
      missions,
      // The period leaderboard when there is one, otherwise the standing
      // profiles — a fleet that ran nothing today should still be able to
      // show what it knows about its workers.
      topWorkers:
        workerBoard.length > 0
          ? workerBoard.map((row) => ({
              label: row.subjectLabel,
              successRate: row.successRate,
              executions: row.samples,
              confidence: row.confidence,
            }))
          : profiles.map((p) => ({
              label: p.workerId,
              successRate: p.successRate,
              executions: p.executions,
              confidence: p.confidence,
            })),
      topProviders: providerBoard.map((row) => ({
        label: row.subjectLabel,
        successRate: row.successRate,
        samples: row.samples,
        avgLatencyMs: row.avgLatencyMs,
      })),
      fastestMissions: reviews
        .filter((r) => r.outcome === 'SUCCESS' && r.completionMs > 0)
        .sort((a, b) => a.completionMs - b.completionMs)
        .slice(0, 5)
        .map((r) => ({
          objective: r.objective.slice(0, 120),
          completionMs: r.completionMs,
          successScore: r.successScore,
        })),
      reliableWorkflows: workflowBoard.map((row) => ({
        label: row.subjectLabel,
        successRate: row.successRate,
        samples: row.samples,
      })),
      knowledge: {
        documents: documents.length,
        openFindings: openFindings.length,
        avgConfidence: avgKnowledgeConfidence,
        growth: newDocuments,
      },
      opportunities: openRecommendations.map((r) => ({
        id: r.id,
        title: r.title,
        impactSummary: r.impactSummary,
        priority: r.priority,
        confidence: r.confidence,
        band: Confidence.bandFor(r.confidence),
      })),
      patterns: patterns.map((p) => ({
        statement: p.statement,
        occurrences: p.occurrences,
        confidence: p.confidence,
        band: p.band,
      })),
      experiments: experiments.map((e) => ({
        name: e.name,
        status: e.status,
        winner: e.winner,
        confidence: e.confidence,
      })),
      improvement,
    };
  }

  /** The learning repository: institutional memory, browsable. */
  async history(kind?: LearningEntryKind, take = 50): Promise<LearningEntry[]> {
    if (kind) return this.entries.ofKind(kind, take);
    return this.entries.current(take);
  }

  /**
   * Writes a lesson by hand.
   *
   * The repository is not only machine-written: a person who has just
   * discovered why something kept failing should be able to record it in the
   * same place the system records what it noticed, or the institutional
   * memory is only half the institution's.
   */
  async record(input: {
    kind: LearningEntryKind;
    title: string;
    body: string;
    tags?: string[];
    data?: Record<string, unknown>;
    confidence?: number;
    sampleSize?: number;
  }): Promise<LearningEntry> {
    const entry = await this.entries.create({
      kind: input.kind,
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      data: (input.data ?? {}) as never,
      sourceType: 'human',
      confidence: input.confidence ?? 1,
      sampleSize: input.sampleSize ?? 0,
    });

    await this.events.publish(DomainEvent.LessonRecorded, {
      entryId: entry.id,
      kind: entry.kind,
      title: entry.title,
    });

    return entry;
  }

  /** Supersede an entry whose conclusion no longer holds. */
  async supersede(id: string, replacementId: string): Promise<LearningEntry> {
    return this.entries.update(id, {
      supersededById: replacementId,
      supersededAt: new Date(),
    });
  }

  // ----------------------------------------------------------------
  // Pure composition
  // ----------------------------------------------------------------

  static missionStats(reviews: Array<{
    outcome: string;
    successScore: number;
    costUsd: number;
  }>): LearningDigest['missions'] {
    const reviewed = reviews.length;
    const succeeded = reviews.filter((r) => r.outcome === 'SUCCESS').length;
    const partial = reviews.filter((r) => r.outcome === 'PARTIAL').length;
    const failed = reviews.filter((r) => r.outcome === 'FAILURE').length;
    const totalCostUsd = Number(reviews.reduce((s, r) => s + r.costUsd, 0).toFixed(6));

    return {
      reviewed,
      succeeded,
      partial,
      failed,
      avgSuccessScore:
        reviewed > 0
          ? Number((reviews.reduce((s, r) => s + r.successScore, 0) / reviewed).toFixed(4))
          : 0,
      avgCostUsd: reviewed > 0 ? Number((totalCostUsd / reviewed).toFixed(6)) : 0,
      totalCostUsd,
    };
  }

  /**
   * Compares this window against the one before it.
   *
   * Returns `unknown` rather than `steady` when either window is empty —
   * "nothing to compare" and "no change" are different claims, and a
   * dashboard that reports the first as the second is quietly lying about
   * having measured something.
   */
  static compare(
    current: LearningDigest['missions'],
    previous: LearningDigest['missions'],
    days: number,
  ): LearningDigest['improvement'] {
    if (current.reviewed === 0 || previous.reviewed === 0) {
      return {
        successRateChange: 0,
        costChange: 0,
        direction: 'unknown',
        summary:
          current.reviewed === 0
            ? `No missions completed in the last ${days} days.`
            : `No prior ${days}-day window to compare against yet.`,
      };
    }

    const successRateChange = Number(
      (current.avgSuccessScore - previous.avgSuccessScore).toFixed(4),
    );
    const costChange = Number((current.avgCostUsd - previous.avgCostUsd).toFixed(6));

    const direction =
      Math.abs(successRateChange) < 0.05
        ? 'steady'
        : successRateChange > 0
          ? 'improving'
          : 'declining';

    const costPhrase =
      Math.abs(costChange) < 0.0001
        ? 'cost per mission unchanged'
        : costChange < 0
          ? `cost per mission down $${Math.abs(costChange).toFixed(4)}`
          : `cost per mission up $${costChange.toFixed(4)}`;

    return {
      successRateChange,
      costChange,
      direction,
      summary:
        `Success score ${direction} by ${(Math.abs(successRateChange) * 100).toFixed(1)} points ` +
        `against the previous ${days} days, ${costPhrase}.`,
    };
  }

  /**
   * The list a person actually reads.
   *
   * Only genuinely new things go in it — a pattern that was already known
   * last week is not something learned this week, and padding the list with
   * standing facts is how a "what did we learn" feature becomes wallpaper.
   */
  static whatWasLearned(input: {
    reviews: number;
    patterns: Array<{ statement: string; confidence: number; band: string; occurrences: number }>;
    recommendations: Array<{ title: string; impactSummary: string; confidence: number }>;
    experiments: Array<{ name: string; winner: string | null; conclusion: string | null }>;
    newDocuments: number;
    openFindings: number;
    improvement: LearningDigest['improvement'];
  }): string[] {
    const learned: string[] = [];

    // Established patterns first — those are the actual knowledge.
    for (const pattern of input.patterns.filter(
      (p) => p.band === 'ESTABLISHED' || p.band === 'STRONG',
    )) {
      learned.push(
        `${pattern.statement} (${pattern.band.toLowerCase()}, ${pattern.occurrences} observations)`,
      );
    }

    for (const experiment of input.experiments.filter((e) => e.winner)) {
      learned.push(`Experiment "${experiment.name}": ${experiment.conclusion ?? 'concluded'}.`);
    }

    const actionable = input.recommendations.filter((r) => Confidence.isActionable(r.confidence));
    if (actionable.length > 0) {
      learned.push(
        `${actionable.length} improvement(s) are backed by enough evidence to act on, ` +
          `starting with: ${actionable[0].title} — ${actionable[0].impactSummary}.`,
      );
    }

    if (input.improvement.direction !== 'unknown' && input.improvement.direction !== 'steady') {
      learned.push(input.improvement.summary);
    }

    if (input.newDocuments > 0) {
      learned.push(`${input.newDocuments} new knowledge document(s) were added.`);
    }

    if (input.openFindings > 0) {
      learned.push(`${input.openFindings} knowledge quality issue(s) are waiting on a decision.`);
    }

    if (learned.length === 0) {
      learned.push(
        input.reviews === 0
          ? 'Nothing ran this week, so there was nothing to learn from.'
          : `${input.reviews} mission(s) were reviewed, but nothing yet recurs often enough ` +
            'to draw a conclusion from.',
      );
    }

    return learned;
  }

  static headline(
    learned: string[],
    missions: LearningDigest['missions'],
    improvement: LearningDigest['improvement'],
  ): string {
    if (missions.reviewed === 0) return 'No completed missions in this window.';

    const rate =
      missions.reviewed > 0
        ? ((missions.succeeded / missions.reviewed) * 100).toFixed(0)
        : '0';

    return (
      `${missions.reviewed} mission(s) reviewed, ${rate}% clean, ` +
      `$${missions.totalCostUsd.toFixed(4)} spent — ${improvement.direction}. ` +
      `${learned.length} thing(s) learned.`
    );
  }
}
