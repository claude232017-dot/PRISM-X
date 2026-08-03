import * as Confidence from './confidence';
import { MissionReviewService } from './mission-review.service';
import { PerformanceAnalyticsService } from './performance-analytics.service';
import { RecommendationService } from './recommendation.service';
import { WorkerOptimizerService } from './worker-optimizer.service';
import { WorkflowOptimizerService } from './workflow-optimizer.service';
import { KnowledgeEvolutionService } from './knowledge-evolution.service';
import { PatternRecognitionService } from './pattern-recognition.service';
import { LearningDashboardService } from './learning-dashboard.service';
import { MetricPeriod, RecommendationKind } from '@prisma/client';

describe('evidence volume', () => {
  it('is zero with no observations at all', () => {
    expect(Confidence.volumeWeight(0)).toBe(0);
  });

  it('reaches exactly half at the saturation point', () => {
    expect(Confidence.volumeWeight(Confidence.EVIDENCE_SATURATION)).toBeCloseTo(0.5, 5);
  });

  it('rises steeply where it matters and flattens beyond', () => {
    const early = Confidence.volumeWeight(10) - Confidence.volumeWeight(5);
    const late = Confidence.volumeWeight(305) - Confidence.volumeWeight(300);
    expect(early).toBeGreaterThan(late * 10);
  });

  it('never quite reaches certainty, however much evidence there is', () => {
    expect(Confidence.volumeWeight(1_000_000)).toBeLessThan(1);
  });

  it('ignores a fractional or negative count rather than propagating nonsense', () => {
    expect(Confidence.volumeWeight(-5)).toBe(0);
    expect(Confidence.volumeWeight(3.7)).toBe(Confidence.volumeWeight(3));
  });
});

describe('recency', () => {
  it('does not discount evidence gathered now', () => {
    expect(Confidence.recencyWeight(0)).toBe(1);
  });

  it('decays as evidence ages', () => {
    expect(Confidence.recencyWeight(30)).toBeLessThan(Confidence.recencyWeight(1));
    expect(Confidence.recencyWeight(90)).toBeLessThan(Confidence.recencyWeight(30));
  });

  it('never discards old evidence entirely — 500 missions last quarter still count', () => {
    expect(Confidence.recencyWeight(3650)).toBeGreaterThanOrEqual(Confidence.RECENCY_FLOOR);
  });

  it('respects a domain-specific half-life', () => {
    const slow = Confidence.recencyWeight(30, 365);
    const fast = Confidence.recencyWeight(30, 7);
    expect(slow).toBeGreaterThan(fast);
  });
});

describe('consistency', () => {
  it('rates identical measurements as perfectly consistent', () => {
    expect(Confidence.consistencyOf([100, 100, 100])).toBe(1);
  });

  it('rates wildly varying measurements as inconsistent', () => {
    expect(Confidence.consistencyOf([1, 500, 3, 900])).toBeLessThan(0.4);
  });

  it('is scale-free — the same relative spread scores the same', () => {
    const small = Confidence.consistencyOf([90, 100, 110]);
    const large = Confidence.consistencyOf([9000, 10000, 11000]);
    expect(small).toBeCloseTo(large, 5);
  });

  it('assumes rather than asserts when there is too little to compare', () => {
    expect(Confidence.consistencyOf([])).toBe(Confidence.ASSUMED_CONSISTENCY);
    expect(Confidence.consistencyOf([42])).toBe(Confidence.ASSUMED_CONSISTENCY);
  });

  it('treats all-zero measurements as agreement, not a division by zero', () => {
    expect(Confidence.consistencyOf([0, 0, 0])).toBe(1);
  });

  it('ignores non-finite values rather than returning NaN', () => {
    expect(Confidence.consistencyOf([10, Number.NaN, 10])).toBe(1);
  });
});

describe('Wilson bounds', () => {
  it('rates three-for-three well below its observed rate', () => {
    const bound = Confidence.wilsonLowerBound(3, 3);
    expect(bound).toBeLessThan(0.6);
    expect(bound).toBeGreaterThan(0.3);
  });

  it('rates 480-of-500 close to its observed rate', () => {
    expect(Confidence.wilsonLowerBound(480, 500)).toBeGreaterThan(0.93);
  });

  it('ranks a large sample above a small perfect one — the whole point', () => {
    expect(Confidence.wilsonLowerBound(480, 500)).toBeGreaterThan(
      Confidence.wilsonLowerBound(3, 3),
    );
  });

  it('returns zero for no trials rather than dividing by zero', () => {
    expect(Confidence.wilsonLowerBound(0, 0)).toBe(0);
  });

  it('brackets the observed rate between its bounds', () => {
    const observed = 17 / 20;
    expect(Confidence.wilsonLowerBound(17, 20)).toBeLessThan(observed);
    expect(Confidence.wilsonUpperBound(17, 20)).toBeGreaterThan(observed);
  });

  it('narrows as evidence accumulates', () => {
    const narrow =
      Confidence.wilsonUpperBound(900, 1000) - Confidence.wilsonLowerBound(900, 1000);
    const wide = Confidence.wilsonUpperBound(9, 10) - Confidence.wilsonLowerBound(9, 10);
    expect(narrow).toBeLessThan(wide);
  });

  it('clamps a nonsensical success count instead of exceeding one', () => {
    expect(Confidence.wilsonLowerBound(50, 10)).toBeLessThanOrEqual(1);
  });
});

describe('composite score', () => {
  it('treats three observations as anecdotal and five hundred as strong', () => {
    const thin = Confidence.score({ samples: 3, consistency: 1 });
    const thick = Confidence.score({ samples: 500, consistency: 1 });
    expect(thin.band).toBe('ANECDOTAL');
    expect(thick.band).toBe('STRONG');
  });

  it('multiplies rather than averages, so one fatal factor sinks the claim', () => {
    // Perfect consistency and perfect recency cannot rescue three data points.
    const rescued = Confidence.score({ samples: 3, consistency: 1, ageDays: 0 });
    expect(rescued.value).toBeLessThan(0.3);
  });

  it('is zero with no observations, whatever else is claimed', () => {
    expect(Confidence.score({ samples: 0, consistency: 1 }).value).toBe(0);
  });

  it('reports the factors so a low score can be argued with', () => {
    const result = Confidence.score({ samples: 40, consistency: 0.4 });
    expect(result.factors.volume).toBeGreaterThan(0.7);
    expect(result.factors.quality).toBeCloseTo(0.4, 5);
    expect(result.rationale).toMatch(/disagree with each other/);
  });

  it('names volume as the limit when the sample is thin', () => {
    expect(Confidence.score({ samples: 2, consistency: 1 }).rationale).toMatch(/thin basis/);
  });

  it('names staleness as the limit when the evidence is old', () => {
    const stale = Confidence.score({ samples: 400, consistency: 1, ageDays: 400 });
    expect(stale.rationale).toMatch(/stale/);
  });

  it('says plainly when there is no evidence at all', () => {
    expect(Confidence.score({ samples: 0 }).rationale).toMatch(/hypothesis, not a finding/);
  });

  it('exposes a percentage that matches the value', () => {
    const result = Confidence.score({ samples: 50 });
    expect(result.percent).toBe(Math.round(result.value * 100));
  });

  it('assumes short of certain when consistency cannot be measured', () => {
    expect(Confidence.score({ samples: 100 }).factors.quality).toBe(
      Confidence.ASSUMED_CONSISTENCY,
    );
  });
});

describe('comparing two rates', () => {
  it('refuses to claim a difference when the intervals overlap', () => {
    const result = Confidence.comparisonConfidence(
      { successes: 6, trials: 10 },
      { successes: 5, trials: 10 },
    );
    expect(result.value).toBe(0);
    expect(result.rationale).toMatch(/overlap/);
  });

  it('returns exactly zero rather than a small number for "cannot tell"', () => {
    // Nine of ten against eight of ten is not a small effect, it is no
    // measurable effect — and rounding one into the other is how a learning
    // system talks itself into nonsense.
    expect(
      Confidence.comparisonConfidence(
        { successes: 9, trials: 10 },
        { successes: 8, trials: 10 },
      ).value,
    ).toBe(0);
  });

  it('claims a difference when the intervals separate cleanly', () => {
    const result = Confidence.comparisonConfidence(
      { successes: 190, trials: 200 },
      { successes: 100, trials: 200 },
    );
    expect(result.value).toBeGreaterThan(0.5);
    expect(result.rationale).toMatch(/separate cleanly/);
  });

  it('is symmetric — argument order does not change the verdict', () => {
    const a = Confidence.comparisonConfidence(
      { successes: 190, trials: 200 },
      { successes: 100, trials: 200 },
    );
    const b = Confidence.comparisonConfidence(
      { successes: 100, trials: 200 },
      { successes: 190, trials: 200 },
    );
    expect(a.value).toBeCloseTo(b.value, 5);
  });
});

describe('bands and actionability', () => {
  it.each([
    [0.95, 'STRONG'],
    [0.7, 'ESTABLISHED'],
    [0.5, 'EMERGING'],
    [0.1, 'ANECDOTAL'],
    [0, 'ANECDOTAL'],
  ] as const)('bands %s as %s', (value, band) => {
    expect(Confidence.bandFor(value)).toBe(band);
  });

  it('treats only established evidence as actionable', () => {
    expect(Confidence.isActionable(0.7)).toBe(true);
    expect(Confidence.isActionable(0.5)).toBe(false);
  });
});

describe('mission review analysis', () => {
  it('scores a clean run near the top', () => {
    const score = MissionReviewService.scoreSuccess({
      tasks: 4, succeeded: 4, failed: 0, retries: 0, overBudget: false, outcome: 'SUCCESS',
    });
    expect(score).toBe(1);
  });

  it('penalises retries and budget overrun', () => {
    const clean = MissionReviewService.scoreSuccess({
      tasks: 4, succeeded: 4, failed: 0, retries: 0, overBudget: false, outcome: 'SUCCESS',
    });
    const messy = MissionReviewService.scoreSuccess({
      tasks: 4, succeeded: 4, failed: 0, retries: 3, overBudget: true, outcome: 'SUCCESS',
    });
    expect(messy).toBeLessThan(clean);
  });

  it('scores a cancelled mission at zero', () => {
    expect(
      MissionReviewService.scoreSuccess({
        tasks: 4, succeeded: 2, failed: 0, retries: 0, overBudget: false, outcome: 'CANCELLED',
      }),
    ).toBe(0);
  });

  it('never leaves the 0..1 range', () => {
    const score = MissionReviewService.scoreSuccess({
      tasks: 2, succeeded: 0, failed: 2, retries: 20, overBudget: true, outcome: 'FAILURE',
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('calls a mostly-done failure partial rather than a flat failure', () => {
    expect(MissionReviewService.outcomeFor('FAILED', 3, 1)).toBe('PARTIAL');
    expect(MissionReviewService.outcomeFor('FAILED', 0, 4)).toBe('FAILURE');
  });

  it('calls a completed mission with a failed task partial', () => {
    expect(MissionReviewService.outcomeFor('COMPLETED', 3, 1)).toBe('PARTIAL');
    expect(MissionReviewService.outcomeFor('COMPLETED', 4, 0)).toBe('SUCCESS');
  });

  it('collapses error messages so the same fault is recognisable twice', () => {
    const a = MissionReviewService.errorSignature(
      'Request 4a9f2c81b7e failed after 3 attempts at 2026-08-03T09:12:44Z',
    );
    const b = MissionReviewService.errorSignature(
      'Request 77b1e0d3aa2 failed after 5 attempts at 2026-08-04T11:02:01Z',
    );
    expect(a).toBe(b);
  });

  it('keeps distinct faults distinct', () => {
    expect(MissionReviewService.errorSignature('rate limit exceeded')).not.toBe(
      MissionReviewService.errorSignature('connection refused'),
    );
  });

  it('counts a single human action as some attention, not none', () => {
    expect(MissionReviewService.estimateHumanMinutes([{ createdAt: new Date() }])).toBe(1);
    expect(MissionReviewService.estimateHumanMinutes([])).toBe(0);
  });

  it('does not bill overnight gaps as human attention', () => {
    const start = new Date('2026-08-03T09:00:00Z');
    const nextMorning = new Date('2026-08-04T09:00:00Z');
    expect(
      MissionReviewService.estimateHumanMinutes([
        { createdAt: start },
        { createdAt: nextMorning },
      ]),
    ).toBeLessThanOrEqual(6);
  });
});

describe('performance metrics', () => {
  it('takes the nearest observed value for a percentile, not an invented one', () => {
    const values = [10, 20, 30, 40];
    expect(values).toContain(PerformanceAnalyticsService.percentile(values, 0.95));
  });

  it('reports zero for a percentile of nothing', () => {
    expect(PerformanceAnalyticsService.percentile([], 0.95)).toBe(0);
  });

  it('averages an empty set to zero rather than NaN', () => {
    expect(PerformanceAnalyticsService.mean([])).toBe(0);
  });

  it('starts a week on Monday, counting Sunday as the seventh day', () => {
    // 2026-08-02 is a Sunday; its week began Monday 2026-07-27.
    const start = PerformanceAnalyticsService.periodStart(
      MetricPeriod.WEEK,
      new Date('2026-08-02T15:00:00Z'),
    );
    expect(start.toISOString()).toBe('2026-07-27T00:00:00.000Z');
  });

  it('truncates a day and a month to their start', () => {
    expect(
      PerformanceAnalyticsService.periodStart(
        MetricPeriod.DAY,
        new Date('2026-08-03T15:44:12Z'),
      ).toISOString(),
    ).toBe('2026-08-03T00:00:00.000Z');
    expect(
      PerformanceAnalyticsService.periodStart(
        MetricPeriod.MONTH,
        new Date('2026-08-03T15:44:12Z'),
      ).toISOString(),
    ).toBe('2026-08-01T00:00:00.000Z');
  });

  it('ends a period exactly where the next one starts', () => {
    const start = PerformanceAnalyticsService.periodStart(
      MetricPeriod.DAY,
      new Date('2026-08-03T15:00:00Z'),
    );
    expect(PerformanceAnalyticsService.periodEnd(MetricPeriod.DAY, start).toISOString()).toBe(
      '2026-08-04T00:00:00.000Z',
    );
  });
});

describe('recommendation ranking', () => {
  it('weights impact by confidence', () => {
    expect(RecommendationService.priorityOf(0.8, 0.5)).toBe(0.4);
  });

  it('ranks a modest, well-evidenced change above a large guess', () => {
    const evidenced = RecommendationService.priorityOf(0.3, 0.9);
    const guess = RecommendationService.priorityOf(0.9, 0.2);
    expect(evidenced).toBeGreaterThan(guess);
  });

  it('clamps nonsense inputs into range', () => {
    expect(RecommendationService.priorityOf(5, 5)).toBe(1);
    expect(RecommendationService.priorityOf(-1, 0.5)).toBe(0);
  });

  it('rates structural workflow changes as riskier than a model switch', () => {
    expect(RecommendationService.riskFor(RecommendationKind.WORKFLOW_PRUNE, 0.9)).toBe('MEDIUM');
    expect(RecommendationService.riskFor(RecommendationKind.WORKFLOW_PRUNE, 0.5)).toBe('HIGH');
    expect(RecommendationService.riskFor(RecommendationKind.MODEL_SWITCH, 0.9)).toBe('LOW');
  });

  it('never rates a tool-permission change as low risk', () => {
    expect(RecommendationService.riskFor(RecommendationKind.TOOL_PERMISSION, 1)).toBe('MEDIUM');
  });

  it('raises risk when confidence is weak, whatever the change', () => {
    expect(RecommendationService.riskFor(RecommendationKind.MODEL_SWITCH, 0.2)).toBe('MEDIUM');
  });
});

describe('provider arm selection', () => {
  const arm = (over: Partial<ReturnType<typeof WorkerOptimizerService.armsFrom>[number]>) => ({
    providerId: 'p1', model: null, label: 'p1', runs: 20, successes: 16,
    avgCostUsd: 0.01, avgLatencyMs: 1000, ...over,
  });

  it('ignores arms with too little history to compare', () => {
    expect(WorkerOptimizerService.bestArm([arm({ runs: 2, successes: 2 })])).toBeNull();
  });

  it('prefers a large good sample over a small perfect one', () => {
    const best = WorkerOptimizerService.bestArm([
      arm({ providerId: 'lucky', runs: 5, successes: 5 }),
      arm({ providerId: 'proven', runs: 200, successes: 190 }),
    ]);
    expect(best?.providerId).toBe('proven');
  });

  it('breaks a reliability tie toward the cheaper arm', () => {
    const best = WorkerOptimizerService.bestArm([
      arm({ providerId: 'pricey', avgCostUsd: 0.5 }),
      arm({ providerId: 'cheap', avgCostUsd: 0.001 }),
    ]);
    expect(best?.providerId).toBe('cheap');
  });

  it('breaks a cost tie toward the faster arm', () => {
    const best = WorkerOptimizerService.bestArm([
      arm({ providerId: 'slow', avgLatencyMs: 9000 }),
      arm({ providerId: 'quick', avgLatencyMs: 200 }),
    ]);
    expect(best?.providerId).toBe('quick');
  });
});

describe('experiment allocation', () => {
  const experiment = { id: 'exp1', allocation: 0.5 };

  it('is deterministic, so an assignment can be recomputed from the record', () => {
    const first = WorkflowOptimizerService.armFor(experiment, 'run-42');
    for (let i = 0; i < 20; i += 1) {
      expect(WorkflowOptimizerService.armFor(experiment, 'run-42')).toBe(first);
    }
  });

  it('splits roughly according to the allocation', () => {
    let variant = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (WorkflowOptimizerService.armFor(experiment, `run-${i}`) === 'variant') variant += 1;
    }
    expect(variant).toBeGreaterThan(400);
    expect(variant).toBeLessThan(600);
  });

  it('honours a skewed allocation', () => {
    let variant = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (WorkflowOptimizerService.armFor({ id: 'e', allocation: 0.1 }, `r-${i}`) === 'variant') {
        variant += 1;
      }
    }
    expect(variant).toBeLessThan(200);
  });

  it('gives different experiments independent assignments for the same run', () => {
    const assignments = new Set(
      ['a', 'b', 'c', 'd'].map((id) =>
        WorkflowOptimizerService.armFor({ id, allocation: 0.5 }, 'same-run'),
      ),
    );
    expect(assignments.size).toBe(2);
  });
});

describe('workflow step flattening', () => {
  it('walks nested branches and children', () => {
    const steps = [
      { id: 'a', type: 'transform', config: {} },
      {
        id: 'b', type: 'condition', config: {},
        onTrue: [{ id: 'c', type: 'transform', config: {} }],
        onFalse: [{ id: 'd', type: 'transform', config: {} }],
      },
      {
        id: 'e', type: 'parallel', config: {},
        steps: [{ id: 'f', type: 'transform', config: {} }],
      },
    ] as never;
    expect(WorkflowOptimizerService.flatten(steps).map((s) => s.id)).toEqual([
      'a', 'b', 'c', 'd', 'e', 'f',
    ]);
  });

  it('finds the most common value, or nothing at all', () => {
    expect(WorkflowOptimizerService.mostCommon(['x', 'y', 'x'])).toEqual({ value: 'x', count: 2 });
    expect(WorkflowOptimizerService.mostCommon([])).toBeNull();
  });
});

describe('knowledge similarity', () => {
  it('rates identical text as fully overlapping', () => {
    const tokens = KnowledgeEvolutionService.tokenise('customer onboarding process guide');
    expect(KnowledgeEvolutionService.jaccard(tokens, tokens)).toBe(1);
  });

  it('rates unrelated text as barely overlapping', () => {
    const a = KnowledgeEvolutionService.tokenise('database migration checklist');
    const b = KnowledgeEvolutionService.tokenise('office parking arrangements');
    expect(KnowledgeEvolutionService.jaccard(a, b)).toBe(0);
  });

  it('does not rate two long documents as similar merely for being long', () => {
    const a = KnowledgeEvolutionService.tokenise(
      Array.from({ length: 60 }, (_, i) => `alpha${i}`).join(' '),
    );
    const b = KnowledgeEvolutionService.tokenise(
      Array.from({ length: 60 }, (_, i) => `beta${i}`).join(' '),
    );
    expect(KnowledgeEvolutionService.jaccard(a, b)).toBe(0);
  });

  it('handles an empty document without dividing by zero', () => {
    expect(KnowledgeEvolutionService.jaccard(new Set(), new Set(['x']))).toBe(0);
  });

  it('drops stop words and very short tokens', () => {
    const tokens = KnowledgeEvolutionService.tokenise('this is the onboarding process');
    expect(tokens.has('this')).toBe(false);
    expect(tokens.has('onboarding')).toBe(true);
  });

  it('suggests tags from the most frequent meaningful words', () => {
    const tags = KnowledgeEvolutionService.suggestTags({
      title: 'Escalation policy',
      content: 'escalation escalation escalation incident incident severity',
      type: 'DOCUMENT',
    } as never);
    expect(tags[0]).toBe('escalation');
  });
});

describe('pattern themes and signatures', () => {
  it('gives the same regularity the same signature every time', () => {
    expect(PatternRecognitionService.signature('failure', 'rate limit')).toBe(
      PatternRecognitionService.signature('failure', 'rate limit'),
    );
  });

  it('gives different regularities different signatures', () => {
    expect(PatternRecognitionService.signature('failure', 'rate limit')).not.toBe(
      PatternRecognitionService.signature('failure', 'timeout'),
    );
  });

  it('groups similar objectives under one theme', () => {
    expect(
      PatternRecognitionService.themeOf('Analyse quarterly revenue for region 1'),
    ).toBe(
      PatternRecognitionService.themeOf('Analyse quarterly revenue for region 7'),
    );
  });

  it('returns nothing for an objective with no meaningful words', () => {
    expect(PatternRecognitionService.themeOf('the and it')).toBeNull();
  });
});

describe('learning digest', () => {
  const missions = (over: Partial<ReturnType<typeof LearningDashboardService.missionStats>>) => ({
    reviewed: 10, succeeded: 8, partial: 1, failed: 1,
    avgSuccessScore: 0.8, avgCostUsd: 0.01, totalCostUsd: 0.1, ...over,
  });

  it('reports "unknown" rather than "steady" with no prior window', () => {
    const result = LearningDashboardService.compare(missions({}), missions({ reviewed: 0 }), 7);
    expect(result.direction).toBe('unknown');
    expect(result.summary).toMatch(/No prior/);
  });

  it('says so plainly when nothing ran', () => {
    const result = LearningDashboardService.compare(missions({ reviewed: 0 }), missions({}), 7);
    expect(result.direction).toBe('unknown');
    expect(result.summary).toMatch(/No missions completed/);
  });

  it('calls a small movement steady rather than a trend', () => {
    const result = LearningDashboardService.compare(
      missions({ avgSuccessScore: 0.81 }),
      missions({ avgSuccessScore: 0.8 }),
      7,
    );
    expect(result.direction).toBe('steady');
  });

  it('detects a real improvement and a real decline', () => {
    expect(
      LearningDashboardService.compare(
        missions({ avgSuccessScore: 0.9 }),
        missions({ avgSuccessScore: 0.6 }),
        7,
      ).direction,
    ).toBe('improving');
    expect(
      LearningDashboardService.compare(
        missions({ avgSuccessScore: 0.5 }),
        missions({ avgSuccessScore: 0.9 }),
        7,
      ).direction,
    ).toBe('declining');
  });

  it('admits when nothing was learned rather than padding the list', () => {
    const learned = LearningDashboardService.whatWasLearned({
      reviews: 4, patterns: [], recommendations: [], experiments: [],
      newDocuments: 0, openFindings: 0,
      improvement: { direction: 'steady', successRateChange: 0, costChange: 0, summary: '' },
    });
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatch(/nothing yet recurs often enough/);
  });

  it('says nothing ran when nothing ran', () => {
    const learned = LearningDashboardService.whatWasLearned({
      reviews: 0, patterns: [], recommendations: [], experiments: [],
      newDocuments: 0, openFindings: 0,
      improvement: { direction: 'unknown', successRateChange: 0, costChange: 0, summary: '' },
    });
    expect(learned[0]).toMatch(/Nothing ran this week/);
  });

  it('leads with established patterns and ignores anecdotal ones', () => {
    const learned = LearningDashboardService.whatWasLearned({
      reviews: 20,
      patterns: [
        { statement: 'Solid finding', confidence: 0.8, band: 'ESTABLISHED', occurrences: 30 },
        { statement: 'Weak hunch', confidence: 0.2, band: 'ANECDOTAL', occurrences: 3 },
      ],
      recommendations: [], experiments: [], newDocuments: 0, openFindings: 0,
      improvement: { direction: 'steady', successRateChange: 0, costChange: 0, summary: '' },
    });
    expect(learned[0]).toMatch(/Solid finding/);
    expect(learned.join(' ')).not.toMatch(/Weak hunch/);
  });

  it('only surfaces recommendations backed by enough evidence to act on', () => {
    const learned = LearningDashboardService.whatWasLearned({
      reviews: 20, patterns: [],
      recommendations: [{ title: 'Thin idea', impactSummary: 'maybe', confidence: 0.2 }],
      experiments: [], newDocuments: 0, openFindings: 0,
      improvement: { direction: 'steady', successRateChange: 0, costChange: 0, summary: '' },
    });
    expect(learned.join(' ')).not.toMatch(/Thin idea/);
  });
});
