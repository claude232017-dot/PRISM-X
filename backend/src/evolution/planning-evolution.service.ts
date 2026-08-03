import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MissionReview, PlanningStrategy } from '@prisma/client';
import { PlanningStrategyRepository } from '../database/repositories/evolution.repositories';
import { MissionReviewRepository } from '../database/repositories/learning.repositories';
import { TaskRepository } from '../database/repositories/tenant.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import * as Confidence from '../learning/confidence';

/** The knobs a planning strategy actually turns. */
export interface PlanningRules {
  /** How many independent tasks the planner will try to run at once. */
  maxParallelism: number;
  /** Prefer the worker with the best record, or spread work around. */
  workerSelection: 'best_available' | 'round_robin' | 'least_loaded';
  /** Pick the provider by reliability, cost, or the worker's own preference. */
  providerSelection: 'reliability' | 'cost' | 'worker_preference';
  /** Split a task into subtasks above this estimated duration, in seconds. */
  decomposeAboveSeconds: number;
  /** Retry budget per task before the mission gives up on it. */
  taskRetries: number;
  /** Order independent tasks longest-first, or in the order given. */
  ordering: 'longest_first' | 'as_declared' | 'cheapest_first';
}

export interface PlanningAnalysis {
  missions: number;
  successRate: number;
  avgCompletionMs: number;
  avgCostUsd: number;
  avgTasksPerMission: number;
  /** What the history suggests changing, and why. */
  observations: Array<{ signal: string; detail: string; suggests: Partial<PlanningRules> }>;
  confidence: number;
}

/**
 * Improving how missions are planned.
 *
 * Planning is the one part of the system that decides how every *other* part
 * gets used — which worker, which provider, in what order, how much at once.
 * Improving it compounds in a way that improving a single worker does not,
 * which is also why getting it wrong compounds.
 *
 * Strategies are compared on the missions they actually produced, never on
 * how sensible their rules look. A strategy is a hypothesis; the mission
 * reviews are the evidence.
 */
@Injectable()
export class PlanningEvolutionService {
  private readonly logger = new Logger(PlanningEvolutionService.name);

  /** Missions needed before a strategy's numbers mean anything. */
  static readonly MIN_MISSIONS = 5;

  /** What planning does before anyone has tuned it. */
  static readonly BASELINE_RULES: PlanningRules = {
    maxParallelism: 2,
    workerSelection: 'best_available',
    providerSelection: 'worker_preference',
    decomposeAboveSeconds: 300,
    taskRetries: 2,
    ordering: 'as_declared',
  };

  constructor(
    private readonly strategies: PlanningStrategyRepository,
    private readonly reviews: MissionReviewRepository,
    private readonly tasks: TaskRepository,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Strategies
  // ----------------------------------------------------------------

  /** The active strategy, creating the baseline if there is none. */
  async active(): Promise<PlanningStrategy> {
    const existing = await this.strategies.findActive();
    if (existing) return existing;

    const baseline = await this.create({
      name: 'baseline',
      description:
        'The planner’s default behaviour, captured so later strategies have ' +
        'something to be measured against.',
      rules: PlanningEvolutionService.BASELINE_RULES,
    });

    return this.strategies.activate(baseline.id);
  }

  async create(input: {
    name: string;
    description: string;
    rules: Partial<PlanningRules>;
    derivedFromId?: string;
  }): Promise<PlanningStrategy> {
    const ctx = RequestContextStore.require();
    const version = await this.strategies.nextVersion(input.name);

    const strategy = await this.strategies.create({
      name: input.name,
      version,
      description: input.description,
      // Merged onto the baseline so a strategy that only changes one knob
      // is still a complete, runnable set of rules rather than a fragment.
      rules: { ...PlanningEvolutionService.BASELINE_RULES, ...input.rules } as never,
      derivedFromId: input.derivedFromId ?? null,
      createdById: ctx.userId,
    });

    await this.events.publish(DomainEvent.PlanningStrategyCreated, {
      strategyId: strategy.id,
      name: strategy.name,
      version: strategy.version,
    });

    return strategy;
  }

  async list(take = 50): Promise<PlanningStrategy[]> {
    return this.strategies.findMany({}, { take, orderBy: { createdAt: 'desc' } });
  }

  async lineage(name: string): Promise<PlanningStrategy[]> {
    return this.strategies.lineage(name);
  }

  /**
   * Makes a strategy the active one.
   *
   * Refuses to activate an unproven strategy over a proven one: switching
   * planning is the highest-leverage change in the system, and doing it on
   * a hunch would undo whatever the previous strategy had earned.
   */
  async activate(id: string, options: { force?: boolean } = {}): Promise<PlanningStrategy> {
    const target = await this.strategies.findByIdOrFail(id);
    const current = await this.strategies.findActive();

    if (
      current &&
      !options.force &&
      current.missionsPlanned >= PlanningEvolutionService.MIN_MISSIONS &&
      target.missionsPlanned < PlanningEvolutionService.MIN_MISSIONS
    ) {
      throw new BadRequestException(
        `"${current.name} v${current.version}" has ${current.missionsPlanned} missions behind it ` +
          `and "${target.name} v${target.version}" has ${target.missionsPlanned}. ` +
          'Measure the new strategy before promoting it, or pass force to override.',
      );
    }

    const activated = await this.strategies.activate(id);
    await this.events.publish(DomainEvent.PlanningStrategyActivated, {
      strategyId: id,
      name: activated.name,
      version: activated.version,
      previous: current ? `${current.name} v${current.version}` : null,
    });

    return activated;
  }

  // ----------------------------------------------------------------
  // Measurement
  // ----------------------------------------------------------------

  /**
   * Attributes recent mission outcomes to the active strategy.
   *
   * Attribution is by time window rather than by tagging each mission,
   * which is approximate and openly so: a mission that started under one
   * strategy and finished under another counts toward whichever was active
   * when it was reviewed. Over enough missions the error washes out; under
   * few missions the confidence score already says not to trust it.
   */
  async measure(): Promise<PlanningStrategy> {
    const strategy = await this.active();
    const since = strategy.activatedAt ?? strategy.createdAt;

    const reviews = await this.reviews.findMany(
      { createdAt: { gte: since } },
      { take: 500, orderBy: { createdAt: 'desc' } },
    );

    if (reviews.length === 0) return strategy;

    const successes = reviews.filter((r) => r.outcome === 'SUCCESS').length;
    const completion = reviews.map((r) => r.completionMs).filter((n) => n > 0);

    return this.strategies.update(strategy.id, {
      missionsPlanned: reviews.length,
      successes,
      successRate: Confidence.wilsonLowerBound(successes, reviews.length),
      avgCompletionMs: Number(
        (completion.reduce((s, n) => s + n, 0) / Math.max(1, completion.length)).toFixed(2),
      ),
      avgCostUsd: Number(
        (reviews.reduce((s, r) => s + r.costUsd, 0) / reviews.length).toFixed(6),
      ),
      avgTasksPerMission: Number(
        (reviews.reduce((s, r) => s + r.taskCount, 0) / reviews.length).toFixed(2),
      ),
      confidence: Confidence.score({
        samples: reviews.length,
        consistency: Confidence.consistencyOf(completion),
      }).value,
    });
  }

  /**
   * Reads mission history and says what planning should do differently.
   *
   * Each observation names the signal it came from, so a suggestion can be
   * checked rather than taken on faith. Below the mission threshold it
   * returns observations but a confidence that says not to act on them.
   */
  async analyse(): Promise<PlanningAnalysis> {
    const reviews = await this.reviews.recent(200);
    const successes = reviews.filter((r) => r.outcome === 'SUCCESS').length;
    const completion = reviews.map((r) => r.completionMs).filter((n) => n > 0);

    const analysis: PlanningAnalysis = {
      missions: reviews.length,
      successRate: Confidence.wilsonLowerBound(successes, reviews.length),
      avgCompletionMs: Number(
        (completion.reduce((s, n) => s + n, 0) / Math.max(1, completion.length)).toFixed(2),
      ),
      avgCostUsd:
        reviews.length > 0
          ? Number((reviews.reduce((s, r) => s + r.costUsd, 0) / reviews.length).toFixed(6))
          : 0,
      avgTasksPerMission:
        reviews.length > 0
          ? Number((reviews.reduce((s, r) => s + r.taskCount, 0) / reviews.length).toFixed(2))
          : 0,
      observations: PlanningEvolutionService.observe(reviews),
      confidence: Confidence.score({
        samples: reviews.length,
        consistency: Confidence.consistencyOf(completion),
      }).value,
    };

    return analysis;
  }

  /**
   * Proposes a strategy from what the history suggests.
   *
   * Created, not activated. A proposed strategy is a hypothesis that has to
   * earn its place against the one currently running.
   */
  async propose(): Promise<{ strategy: PlanningStrategy | null; analysis: PlanningAnalysis }> {
    const analysis = await this.analyse();

    if (analysis.observations.length === 0) {
      return { strategy: null, analysis };
    }
    if (analysis.missions < PlanningEvolutionService.MIN_MISSIONS) {
      return { strategy: null, analysis };
    }

    const current = await this.active();
    const rules = analysis.observations.reduce(
      (merged, observation) => ({ ...merged, ...observation.suggests }),
      { ...(current.rules as unknown as PlanningRules) },
    );

    // A proposal identical to what is already running is not a proposal.
    if (JSON.stringify(rules) === JSON.stringify(current.rules)) {
      return { strategy: null, analysis };
    }

    const strategy = await this.create({
      name: 'derived',
      description:
        `Derived from ${analysis.missions} mission reviews: ` +
        analysis.observations.map((o) => o.signal).join(', '),
      rules,
      derivedFromId: current.id,
    });

    return { strategy, analysis };
  }

  // ----------------------------------------------------------------
  // Pure analysis
  // ----------------------------------------------------------------

  /**
   * What mission history says about how planning should change.
   *
   * Every observation is derived from a counted signal in the reviews. There
   * is no heuristic here that is not backed by something the system actually
   * recorded — planning advice that sounds sensible but has no evidence
   * behind it is exactly what this phase exists to avoid.
   */
  static observe(reviews: MissionReview[]): PlanningAnalysis['observations'] {
    const observations: PlanningAnalysis['observations'] = [];
    if (reviews.length === 0) return observations;

    const unusedParallelism = reviews.filter((r) =>
      ((r.missedOpportunities ?? []) as Array<{ kind?: string }>).some(
        (o) => o.kind === 'unused_parallelism',
      ),
    ).length;

    if (unusedParallelism / reviews.length > 0.3) {
      observations.push({
        signal: 'unused parallelism',
        detail:
          `${unusedParallelism} of ${reviews.length} missions had independent tasks ` +
          'that ran one after another.',
        suggests: { maxParallelism: 4, ordering: 'longest_first' },
      });
    }

    const overran = reviews.filter(
      (r) => r.estimatedMs && r.estimatedMs > 0 && r.completionMs > r.estimatedMs * 1.5,
    ).length;
    const withEstimates = reviews.filter((r) => r.estimatedMs && r.estimatedMs > 0).length;

    if (withEstimates > 0 && overran / withEstimates > 0.4) {
      observations.push({
        signal: 'estimate drift',
        detail: `${overran} of ${withEstimates} missions took over 1.5× their planned time.`,
        suggests: { decomposeAboveSeconds: 150 },
      });
    }

    const retried = reviews.filter((r) => r.retryCount > 2).length;
    if (retried / reviews.length > 0.25) {
      observations.push({
        signal: 'heavy retrying',
        detail: `${retried} of ${reviews.length} missions needed more than two retries.`,
        suggests: { providerSelection: 'reliability', taskRetries: 3 },
      });
    }

    const overBudget = reviews.filter(
      (r) => r.estimatedCostUsd && r.estimatedCostUsd > 0 && r.costUsd > r.estimatedCostUsd * 1.5,
    ).length;
    const withCostEstimates = reviews.filter(
      (r) => r.estimatedCostUsd && r.estimatedCostUsd > 0,
    ).length;

    if (withCostEstimates > 0 && overBudget / withCostEstimates > 0.4) {
      observations.push({
        signal: 'budget overrun',
        detail: `${overBudget} of ${withCostEstimates} missions exceeded their cost estimate.`,
        suggests: { providerSelection: 'cost', ordering: 'cheapest_first' },
      });
    }

    const bottlenecked = reviews.filter(
      (r) => ((r.bottlenecks ?? []) as unknown[]).length > 0,
    ).length;

    if (bottlenecked / reviews.length > 0.4) {
      observations.push({
        signal: 'recurring bottlenecks',
        detail: `${bottlenecked} of ${reviews.length} missions had a single dominating task.`,
        suggests: { decomposeAboveSeconds: 120, maxParallelism: 3 },
      });
    }

    return observations;
  }

  /** Whether a strategy has earned the right to replace another. */
  static outperforms(
    candidate: Pick<PlanningStrategy, 'successRate' | 'missionsPlanned' | 'avgCostUsd'>,
    incumbent: Pick<PlanningStrategy, 'successRate' | 'missionsPlanned' | 'avgCostUsd'>,
  ): boolean {
    if (candidate.missionsPlanned < PlanningEvolutionService.MIN_MISSIONS) return false;
    if (candidate.successRate > incumbent.successRate) return true;

    // Equal reliability at lower cost is a genuine improvement; the reverse
    // is not, which is why this is not a symmetric comparison.
    return (
      Math.abs(candidate.successRate - incumbent.successRate) < 0.02 &&
      candidate.avgCostUsd < incumbent.avgCostUsd * 0.9
    );
  }
}
