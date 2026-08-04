import { Injectable, Logger } from '@nestjs/common';
import {
  EvolutionCandidate,
  EvolutionKind,
  EvolutionPolicy,
  ExperimentMode,
  RiskLevel,
} from '@prisma/client';
import {
  DeploymentRepository,
  EvolutionExperimentRepository,
  EvolutionPolicyRepository,
} from '../database/repositories/evolution.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';

export interface PolicyDecision {
  satisfied: boolean;
  /** Why not, when not. Written for a human reading a refused deployment. */
  reason?: string;
  /** Whether this change needs a person regardless of evidence. */
  requiresApproval: boolean;
  /** Every rule consulted, so a decision can be argued with. */
  checks: Array<{ rule: string; passed: boolean; detail?: string }>;
}

/**
 * Each organization's own limits on how it is allowed to change.
 *
 * The Constitution is the floor and cannot be lowered by anyone; the policy
 * is the ceiling and every organization sets its own. The split matters:
 * "never bypass approval where it is required" is a law because a system
 * that could ignore it would make every other control advisory, while
 * *which* changes require approval is a business decision that a media
 * agency and a hospital should answer differently.
 *
 * Defaults are conservative and are created on first access rather than
 * requiring setup, because an organization that has never configured
 * evolution should not thereby be evolving freely.
 */
@Injectable()
export class EvolutionPolicyService {
  private readonly logger = new Logger(EvolutionPolicyService.name);

  /**
   * What a brand-new organization gets.
   *
   * Prompt optimization and limit tuning are permitted because they are
   * reversible and bounded. Provider and model changes are permitted but
   * always need a person, because they move spend and data to a different
   * vendor. Workflow structure and tool permissions are absent from
   * `allowedKinds` entirely — an organization has to opt in deliberately.
   */
  static readonly DEFAULTS = {
    enabled: true,
    allowedKinds: [
      EvolutionKind.PROMPT_OPTIMIZATION,
      EvolutionKind.EXECUTION_LIMITS,
      EvolutionKind.MEMORY_STRATEGY,
      EvolutionKind.MODEL_CHANGE,
      EvolutionKind.PROVIDER_CHANGE,
      EvolutionKind.PLANNING_STRATEGY,
    ],
    requireApproval: [
      EvolutionKind.PROVIDER_CHANGE,
      EvolutionKind.MODEL_CHANGE,
      EvolutionKind.TOOL_PERMISSION,
      EvolutionKind.WORKFLOW_STRUCTURE,
      EvolutionKind.WORKFLOW_PARALLELISM,
      EvolutionKind.WORKFLOW_SIMPLIFICATION,
      EvolutionKind.MISSION_TEMPLATE,
    ],
    allowedModes: [ExperimentMode.SANDBOX, ExperimentMode.SHADOW, ExperimentMode.CANARY],
    autoApproveThreshold: 0.95,
    maxUnattendedRisk: RiskLevel.LOW,
    minTrialsPerArm: 10,
    maxConcurrentExperiments: 3,
    maxDeploymentsPerDay: 5,
    monitorWindowMinutes: 60,
    autoRollbackThreshold: 0.3,
    autoRollbackEnabled: true,
  };

  private static readonly RISK_ORDER: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

  constructor(
    private readonly policies: EvolutionPolicyRepository,
    private readonly experiments: EvolutionExperimentRepository,
    private readonly deployments: DeploymentRepository,
    private readonly events: EventBusService,
  ) {}

  /** The organization's policy, created with safe defaults if absent. */
  async get(): Promise<EvolutionPolicy> {
    const existing = await this.policies.find();
    if (existing) return existing;
    return this.policies.upsert(EvolutionPolicyService.DEFAULTS as never);
  }

  async update(changes: Partial<EvolutionPolicy>): Promise<EvolutionPolicy> {
    const ctx = RequestContextStore.require();
    await this.get();

    const updated = await this.policies.upsert({
      ...(changes as Record<string, unknown>),
      updatedById: ctx.userId,
    });

    await this.events.publish(DomainEvent.EvolutionPolicyUpdated, {
      changed: Object.keys(changes),
      enabled: updated.enabled,
    });

    return updated;
  }

  // ----------------------------------------------------------------
  // Decisions
  // ----------------------------------------------------------------

  /**
   * Whether a candidate may be deployed, and whether a person must say so.
   *
   * Every rule is evaluated rather than short-circuiting, so an operator
   * sees all the reasons at once instead of fixing them one refusal at a
   * time.
   */
  async evaluate(
    candidate: Pick<EvolutionCandidate, 'kind' | 'risk' | 'confidence'>,
    options: { at?: Date; benchmarkTrials?: number } = {},
  ): Promise<PolicyDecision> {
    const policy = await this.get();
    const at = options.at ?? new Date();
    const checks: PolicyDecision['checks'] = [];

    checks.push({
      rule: 'enabled',
      passed: policy.enabled,
      detail: policy.enabled ? undefined : 'evolution deployment is switched off',
    });

    const kindAllowed = policy.allowedKinds.includes(candidate.kind);
    checks.push({
      rule: 'allowed_kind',
      passed: kindAllowed,
      detail: kindAllowed
        ? undefined
        : `${candidate.kind} is not in this organization's allowed kinds`,
    });

    const inWindow = EvolutionPolicyService.withinWindow(policy, at);
    checks.push({
      rule: 'deployment_window',
      passed: inWindow.passed,
      detail: inWindow.detail,
    });

    const trialsRequired = policy.minTrialsPerArm;
    const trials = options.benchmarkTrials ?? 0;
    const enoughTrials = trials >= trialsRequired;
    checks.push({
      rule: 'minimum_trials',
      passed: enoughTrials,
      detail: enoughTrials
        ? undefined
        : `only ${trials} trial(s) on the weaker arm; ${trialsRequired} required`,
    });

    const since = new Date(at.getTime() - 86_400_000);
    const deployedToday = await this.deployments.countSince(since);
    const underCap =
      policy.maxDeploymentsPerDay === 0 || deployedToday < policy.maxDeploymentsPerDay;
    checks.push({
      rule: 'daily_cap',
      passed: underCap,
      detail: underCap
        ? undefined
        : `${deployedToday} deployment(s) in the last 24h; the cap is ${policy.maxDeploymentsPerDay}`,
    });

    const failed = checks.filter((check) => !check.passed);

    return {
      satisfied: failed.length === 0,
      reason: failed.length > 0 ? failed.map((c) => c.detail).filter(Boolean).join('; ') : undefined,
      requiresApproval: EvolutionPolicyService.requiresApproval(policy, candidate),
      checks,
    };
  }

  /** Whether an experiment may start in the requested mode. */
  async canExperiment(mode: ExperimentMode): Promise<PolicyDecision> {
    const policy = await this.get();
    const checks: PolicyDecision['checks'] = [];

    // Sandbox touches nothing real, so it is always available. Refusing it
    // would leave an organization unable to measure anything at all, which
    // pushes people toward deploying on a hunch.
    const modeAllowed = mode === ExperimentMode.SANDBOX || policy.allowedModes.includes(mode);
    checks.push({
      rule: 'allowed_mode',
      passed: modeAllowed,
      detail: modeAllowed ? undefined : `${mode} experiments are not permitted here`,
    });

    const running = await this.experiments.countRunning();
    const underCap = running < policy.maxConcurrentExperiments;
    checks.push({
      rule: 'concurrent_experiments',
      passed: underCap,
      detail: underCap
        ? undefined
        : `${running} experiment(s) already running; the cap is ${policy.maxConcurrentExperiments}`,
    });

    const failed = checks.filter((check) => !check.passed);
    return {
      satisfied: failed.length === 0,
      reason: failed.length > 0 ? failed.map((c) => c.detail).filter(Boolean).join('; ') : undefined,
      requiresApproval: false,
      checks,
    };
  }

  // ----------------------------------------------------------------
  // Pure rules
  // ----------------------------------------------------------------

  /**
   * Whether a change needs a person.
   *
   * Three independent triggers, any of which is sufficient: the kind is on
   * the organization's list, the risk exceeds what it will accept
   * unattended, or the evidence falls short of its confidence floor. They
   * are separate because they answer different questions — what kind of
   * change this is, how much damage it could do, and how sure we are.
   */
  static requiresApproval(
    policy: Pick<
      EvolutionPolicy,
      'requireApproval' | 'maxUnattendedRisk' | 'autoApproveThreshold'
    >,
    candidate: Pick<EvolutionCandidate, 'kind' | 'risk' | 'confidence'>,
  ): boolean {
    if (policy.requireApproval.includes(candidate.kind)) return true;

    const riskRank = EvolutionPolicyService.RISK_ORDER.indexOf(candidate.risk);
    const maxRank = EvolutionPolicyService.RISK_ORDER.indexOf(policy.maxUnattendedRisk);
    if (riskRank > maxRank) return true;

    return candidate.confidence < policy.autoApproveThreshold;
  }

  /**
   * Whether the clock permits deploying right now.
   *
   * A deployment window is not a safety feature in itself — it is a
   * staffing one. Its purpose is that when something goes wrong, somebody is
   * awake to notice, which is why the check is against the org's configured
   * hours rather than a fixed idea of "business hours".
   */
  static withinWindow(
    policy: Pick<EvolutionPolicy, 'businessHoursStart' | 'businessHoursEnd' | 'businessDays'>,
    at: Date,
  ): { passed: boolean; detail?: string } {
    if (policy.businessDays.length > 0) {
      const day = at.getUTCDay();
      if (!policy.businessDays.includes(day)) {
        return {
          passed: false,
          detail: `deployment is not permitted on day ${day} (UTC)`,
        };
      }
    }

    const { businessHoursStart: start, businessHoursEnd: end } = policy;
    if (start === null || end === null || start === undefined || end === undefined) {
      return { passed: true };
    }

    const hour = at.getUTCHours();

    // `end` is exclusive and may be 24, meaning midnight — so 0–24 is a window
    // that is always open. Without that, `hour < end` left the 23:00 hour
    // outside every possible window.
    //
    // A window that wraps midnight (22:00 to 04:00) is a real thing an
    // operations team asks for, and reading it as an empty window would
    // silently block every deployment.
    const inside = start <= end ? hour >= start && hour < end : hour >= start || hour < end;

    return inside
      ? { passed: true }
      : {
          passed: false,
          detail: `outside the deployment window (${start}:00–${end}:00 UTC, now ${hour}:00)`,
        };
  }

  static riskAtOrBelow(risk: RiskLevel, ceiling: RiskLevel): boolean {
    return (
      EvolutionPolicyService.RISK_ORDER.indexOf(risk) <=
      EvolutionPolicyService.RISK_ORDER.indexOf(ceiling)
    );
  }
}
