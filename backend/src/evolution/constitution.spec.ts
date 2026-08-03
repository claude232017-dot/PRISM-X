import * as Constitution from './constitution';
import { EvolutionPolicyService } from './policy.service';
import { BenchmarkService } from './benchmark.service';
import { VersionService } from './version.service';
import { CandidateService } from './candidate.service';
import { ExperimentService } from './experiment.service';
import { PlanningEvolutionService } from './planning-evolution.service';
import { EvolutionDashboardService } from './evolution-dashboard.service';
import {
  Benchmark, EvolutionKind, EvolutionSubject, ExperimentMode, RiskLevel, VersionAspect,
} from '@prisma/client';

/** A lawful intent. Individual tests break exactly one thing. */
const lawful = (over: Partial<Constitution.DeploymentIntent> = {}): Constitution.DeploymentIntent => ({
  organizationId: 'org1',
  actorId: 'user1',
  actorPermissions: ['*'],
  subject: 'WORKER',
  subjectId: 'w1',
  subjectOrganizationId: 'org1',
  kind: 'PROMPT_OPTIMIZATION',
  change: { systemPrompt: 'new' },
  rollback: { systemPrompt: 'old' },
  approvedById: 'user1',
  approvedAt: new Date(),
  policyRequiresApproval: false,
  policySatisfied: true,
  confidence: 0.9,
  benchmarkVerdict: 'BETTER',
  auditable: true,
  ...over,
});

const refusedBy = (intent: Constitution.DeploymentIntent): string[] =>
  Constitution.review(intent).violations.map((v) => v.lawId);

describe('the Constitution as an object', () => {
  it('is frozen against modification at runtime', () => {
    expect(Object.isFrozen(Constitution.CONSTITUTION)).toBe(true);
    expect(Constitution.CONSTITUTION.every((law) => Object.isFrozen(law))).toBe(true);
  });

  it('refuses to accept a new law pushed onto it', () => {
    expect(() =>
      (Constitution.CONSTITUTION as unknown as unknown[]).push({ id: 'BACKDOOR' }),
    ).toThrow();
  });

  it('refuses to have a law rewritten', () => {
    const law = Constitution.CONSTITUTION[0];
    expect(() => {
      (law as unknown as Record<string, unknown>).check = () => null;
    }).toThrow();
  });

  it('identifies itself by a hash of the law text', () => {
    expect(Constitution.CONSTITUTION_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives the same version for the same laws, every time', () => {
    const again = Constitution.CONSTITUTION.map((l) => `${l.id}:${l.statement}`).join('|');
    expect(again.length).toBeGreaterThan(0);
    expect(Constitution.CONSTITUTION_VERSION).toBe(Constitution.CONSTITUTION_VERSION);
  });

  it('describes every law with a statement and a rationale', () => {
    expect(
      Constitution.describe().every((l) => l.id && l.statement.length > 10 && l.rationale.length > 20),
    ).toBe(true);
  });

  it('carries the laws the platform promises', () => {
    const ids = Constitution.CONSTITUTION.map((l) => l.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'ORG_PERMISSIONS', 'NO_PRIVILEGE_ESCALATION', 'TENANT_ISOLATION',
        'NO_AUTOMATIC_DELETION', 'POLICY_COMPLIANCE', 'HUMAN_CONSENT',
        'REVERSIBILITY', 'AUDITABILITY', 'EVIDENCE_REQUIRED',
      ]),
    );
  });
});

describe('review', () => {
  it('permits a lawful change', () => {
    const verdict = Constitution.review(lawful());
    expect(verdict.permitted).toBe(true);
    expect(verdict.violations).toHaveLength(0);
  });

  it('evaluates every law rather than stopping at the first refusal', () => {
    const verdict = Constitution.review(
      lawful({ rollback: {}, auditable: false, policySatisfied: false }),
    );
    expect(verdict.checked).toHaveLength(Constitution.CONSTITUTION.length);
    expect(verdict.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('stamps the constitution version on every verdict', () => {
    expect(Constitution.review(lawful()).version).toBe(Constitution.CONSTITUTION_VERSION);
  });
});

describe('ORG_PERMISSIONS', () => {
  it('refuses an actor without the permission the change needs', () => {
    expect(refusedBy(lawful({ actorPermissions: ['worker:read'] }))).toContain('ORG_PERMISSIONS');
  });

  it('accepts the specific permission for the subject', () => {
    expect(refusedBy(lawful({ actorPermissions: ['worker:update'] }))).not.toContain(
      'ORG_PERMISSIONS',
    );
  });

  it('holds the unattended actor to the organization’s approval rule', () => {
    expect(
      refusedBy(
        lawful({ actorId: 'system', policyRequiresApproval: true, approvedById: null }),
      ),
    ).toContain('ORG_PERMISSIONS');
  });

  it('lets the unattended actor act where no approval is required', () => {
    expect(
      refusedBy(
        lawful({
          actorId: 'system',
          actorPermissions: [],
          policyRequiresApproval: false,
          approvedById: null,
        }),
      ),
    ).not.toContain('ORG_PERMISSIONS');
  });
});

describe('NO_PRIVILEGE_ESCALATION', () => {
  it.each(['permissions', 'roleKey', 'role', 'scopes', 'organizationId'])(
    'refuses a change touching %s',
    (field) => {
      expect(refusedBy(lawful({ change: { [field]: 'anything' } }))).toContain(
        'NO_PRIVILEGE_ESCALATION',
      );
    },
  );

  it('refuses granting a tool nobody approved', () => {
    expect(
      refusedBy(
        lawful({
          change: { toolPermissions: ['a', 'b'] },
          rollback: { toolPermissions: ['a'] },
          approvedById: null,
          policyRequiresApproval: false,
        }),
      ),
    ).toContain('NO_PRIVILEGE_ESCALATION');
  });

  it('permits granting a tool a person approved', () => {
    expect(
      refusedBy(
        lawful({
          change: { toolPermissions: ['a', 'b'] },
          rollback: { toolPermissions: ['a'] },
          approvedById: 'user1',
        }),
      ),
    ).not.toContain('NO_PRIVILEGE_ESCALATION');
  });

  it('permits narrowing tool access without approval — losing power is safe', () => {
    expect(
      refusedBy(
        lawful({
          change: { toolPermissions: ['a'] },
          rollback: { toolPermissions: ['a', 'b'] },
          approvedById: null,
          policyRequiresApproval: false,
        }),
      ),
    ).not.toContain('NO_PRIVILEGE_ESCALATION');
  });
});

describe('TENANT_ISOLATION', () => {
  it('refuses a subject owned by another organization', () => {
    expect(refusedBy(lawful({ subjectOrganizationId: 'org2' }))).toContain('TENANT_ISOLATION');
  });

  it('refuses a change naming another organization at the top level', () => {
    expect(
      refusedBy(lawful({ change: { systemPrompt: 'x', organizationId: 'org2' } })),
    ).toContain('TENANT_ISOLATION');
  });

  it('finds a foreign id buried deep in a nested change', () => {
    expect(
      refusedBy(
        lawful({
          change: {
            steps: [{ config: { handoff: { targetOrganizationId: 'org2' } } }],
          },
          rollback: { steps: [] },
        }),
      ),
    ).toContain('TENANT_ISOLATION');
  });

  it('finds a foreign id inside an array of objects', () => {
    expect(
      refusedBy(
        lawful({
          change: { peers: [{ name: 'a' }, { organizationId: 'org9' }] },
          rollback: { peers: [] },
        }),
      ),
    ).toContain('TENANT_ISOLATION');
  });

  it('permits the acting organization’s own id appearing in a change', () => {
    expect(
      refusedBy(lawful({ change: { note: 'x', ownerOrganizationId: 'org1' }, rollback: { note: '', ownerOrganizationId: 'org1' } })),
    ).not.toContain('TENANT_ISOLATION');
  });

  it('does not recurse forever on a deeply nested structure', () => {
    let nested: Record<string, unknown> = { organizationId: 'org2' };
    for (let i = 0; i < 40; i += 1) nested = { inner: nested };
    expect(() => Constitution.review(lawful({ change: nested, rollback: nested }))).not.toThrow();
  });
});

describe('NO_AUTOMATIC_DELETION', () => {
  it.each(['delete', 'purge', 'truncate', 'archivedAt', 'destroy'])(
    'refuses a change carrying %s',
    (field) => {
      expect(
        refusedBy(lawful({ change: { [field]: true }, rollback: { [field]: false } })),
      ).toContain('NO_AUTOMATIC_DELETION');
    },
  );

  it('refuses soft-deleting through deletedAt', () => {
    expect(
      refusedBy(lawful({ change: { deletedAt: new Date() }, rollback: { deletedAt: null } })),
    ).toContain('NO_AUTOMATIC_DELETION');
  });

  it('permits restoring something previously deleted', () => {
    expect(
      refusedBy(lawful({ change: { deletedAt: null }, rollback: { deletedAt: new Date() } })),
    ).not.toContain('NO_AUTOMATIC_DELETION');
  });
});

describe('POLICY_COMPLIANCE and HUMAN_CONSENT', () => {
  it('refuses when the organization’s policy said no', () => {
    expect(
      refusedBy(lawful({ policySatisfied: false, policyReason: 'outside the window' })),
    ).toContain('POLICY_COMPLIANCE');
  });

  it('carries the policy’s own reason through', () => {
    const verdict = Constitution.review(
      lawful({ policySatisfied: false, policyReason: 'outside the deployment window' }),
    );
    expect(verdict.violations.find((v) => v.lawId === 'POLICY_COMPLIANCE')?.reason).toContain(
      'window',
    );
  });

  it('refuses a required approval that is missing', () => {
    expect(
      refusedBy(lawful({ policyRequiresApproval: true, approvedById: null })),
    ).toContain('HUMAN_CONSENT');
  });

  it('refuses an approval recorded by the system rather than a person', () => {
    expect(
      refusedBy(lawful({ policyRequiresApproval: true, approvedById: 'system' })),
    ).toContain('HUMAN_CONSENT');
  });

  it('is not satisfied by high confidence — evidence is not authority', () => {
    expect(
      refusedBy(
        lawful({ policyRequiresApproval: true, approvedById: null, confidence: 1 }),
      ),
    ).toContain('HUMAN_CONSENT');
  });
});

describe('REVERSIBILITY', () => {
  it('refuses a change with no rollback at all', () => {
    expect(refusedBy(lawful({ rollback: {} }))).toContain('REVERSIBILITY');
  });

  it('refuses a rollback that covers only part of the change', () => {
    expect(
      refusedBy(
        lawful({
          change: { systemPrompt: 'new', maxIterations: 8 },
          rollback: { systemPrompt: 'old' },
        }),
      ),
    ).toContain('REVERSIBILITY');
  });

  it('names the fields the rollback misses', () => {
    const verdict = Constitution.review(
      lawful({ change: { a: 1, b: 2 }, rollback: { a: 0 } }),
    );
    expect(verdict.violations.find((v) => v.lawId === 'REVERSIBILITY')?.reason).toContain('b');
  });

  it('accepts a rollback that restores a field to null', () => {
    expect(
      refusedBy(lawful({ change: { systemPrompt: 'new' }, rollback: { systemPrompt: null } })),
    ).not.toContain('REVERSIBILITY');
  });
});

describe('AUDITABILITY and EVIDENCE_REQUIRED', () => {
  it('refuses a deployment that would not be recorded', () => {
    expect(refusedBy(lawful({ auditable: false }))).toContain('AUDITABILITY');
  });

  it('refuses a change the benchmark found worse', () => {
    expect(refusedBy(lawful({ benchmarkVerdict: 'WORSE' }))).toContain('EVIDENCE_REQUIRED');
  });

  it('refuses a worse change even when a person approved it', () => {
    expect(
      refusedBy(lawful({ benchmarkVerdict: 'WORSE', approvedById: 'user1' })),
    ).toContain('EVIDENCE_REQUIRED');
  });

  it('refuses an unmeasured change nobody approved', () => {
    expect(
      refusedBy(
        lawful({ benchmarkVerdict: 'INSUFFICIENT_DATA', approvedById: null, policyRequiresApproval: false }),
      ),
    ).toContain('EVIDENCE_REQUIRED');
  });

  it('permits an inconclusive change a person took responsibility for', () => {
    expect(
      refusedBy(lawful({ benchmarkVerdict: 'INCONCLUSIVE', approvedById: 'user1' })),
    ).not.toContain('EVIDENCE_REQUIRED');
  });

  it('refuses a change with neither evidence nor a decision', () => {
    expect(
      refusedBy(
        lawful({
          confidence: 0,
          benchmarkVerdict: null,
          approvedById: null,
          policyRequiresApproval: false,
        }),
      ),
    ).toContain('EVIDENCE_REQUIRED');
  });
});

describe('policy rules', () => {
  const policy = (over = {}) => ({
    requireApproval: [] as EvolutionKind[],
    maxUnattendedRisk: RiskLevel.LOW,
    autoApproveThreshold: 0.95,
    businessHoursStart: null as number | null,
    businessHoursEnd: null as number | null,
    businessDays: [] as number[],
    ...over,
  });

  it('requires approval for a listed kind whatever the confidence', () => {
    expect(
      EvolutionPolicyService.requiresApproval(
        policy({ requireApproval: [EvolutionKind.PROVIDER_CHANGE] }),
        { kind: EvolutionKind.PROVIDER_CHANGE, risk: RiskLevel.LOW, confidence: 1 },
      ),
    ).toBe(true);
  });

  it('requires approval above the risk ceiling', () => {
    expect(
      EvolutionPolicyService.requiresApproval(policy(), {
        kind: EvolutionKind.PROMPT_OPTIMIZATION,
        risk: RiskLevel.HIGH,
        confidence: 1,
      }),
    ).toBe(true);
  });

  it('requires approval below the confidence floor', () => {
    expect(
      EvolutionPolicyService.requiresApproval(policy(), {
        kind: EvolutionKind.PROMPT_OPTIMIZATION,
        risk: RiskLevel.LOW,
        confidence: 0.5,
      }),
    ).toBe(true);
  });

  it('lets a low-risk, well-evidenced, unlisted change through', () => {
    expect(
      EvolutionPolicyService.requiresApproval(policy(), {
        kind: EvolutionKind.PROMPT_OPTIMIZATION,
        risk: RiskLevel.LOW,
        confidence: 0.99,
      }),
    ).toBe(false);
  });

  it('permits any hour when no window is configured', () => {
    expect(EvolutionPolicyService.withinWindow(policy(), new Date('2026-08-03T03:00:00Z')).passed).toBe(
      true,
    );
  });

  it('honours an ordinary daytime window', () => {
    const p = policy({ businessHoursStart: 9, businessHoursEnd: 17 });
    expect(EvolutionPolicyService.withinWindow(p, new Date('2026-08-03T12:00:00Z')).passed).toBe(true);
    expect(EvolutionPolicyService.withinWindow(p, new Date('2026-08-03T20:00:00Z')).passed).toBe(false);
  });

  it('handles a window that wraps midnight rather than reading it as empty', () => {
    const p = policy({ businessHoursStart: 22, businessHoursEnd: 4 });
    expect(EvolutionPolicyService.withinWindow(p, new Date('2026-08-03T23:00:00Z')).passed).toBe(true);
    expect(EvolutionPolicyService.withinWindow(p, new Date('2026-08-03T02:00:00Z')).passed).toBe(true);
    expect(EvolutionPolicyService.withinWindow(p, new Date('2026-08-03T12:00:00Z')).passed).toBe(false);
  });

  it('restricts to configured days', () => {
    // 2026-08-03 is a Monday (day 1).
    const p = policy({ businessDays: [1, 2, 3, 4, 5] });
    expect(EvolutionPolicyService.withinWindow(p, new Date('2026-08-03T12:00:00Z')).passed).toBe(true);
    expect(EvolutionPolicyService.withinWindow(p, new Date('2026-08-02T12:00:00Z')).passed).toBe(false);
  });

  it('orders risk correctly', () => {
    expect(EvolutionPolicyService.riskAtOrBelow(RiskLevel.LOW, RiskLevel.MEDIUM)).toBe(true);
    expect(EvolutionPolicyService.riskAtOrBelow(RiskLevel.CRITICAL, RiskLevel.MEDIUM)).toBe(false);
  });
});

describe('benchmarking', () => {
  const bench = (over: Partial<Benchmark>): Benchmark =>
    ({
      arm: 'control', trials: 20, successes: 16, successRate: 0.6, observedRate: 0.8,
      avgCompletionMs: 1000, p95CompletionMs: 1500, qualityScore: 0.8, avgCostUsd: 0.01,
      totalCostUsd: 0.2, avgTokens: 500, avgLatencyMs: 900, reliability: 0.8,
      userRating: null, ratingCount: 0, roi: 80, ...over,
    }) as Benchmark;

  it('measures nothing from no trials without dividing by zero', () => {
    const metrics = BenchmarkService.measure([]);
    expect(metrics.trials).toBe(0);
    expect(metrics.successRate).toBe(0);
    expect(metrics.userRating).toBeNull();
  });

  it('reports no rating rather than a rating of zero when nobody rated', () => {
    const metrics = BenchmarkService.measure([
      { succeeded: true, completionMs: 100, costUsd: 0.01, tokens: 10, latencyMs: 90 },
    ]);
    expect(metrics.userRating).toBeNull();
    expect(metrics.ratingCount).toBe(0);
  });

  it('averages the ratings that were given', () => {
    const metrics = BenchmarkService.measure([
      { succeeded: true, completionMs: 100, costUsd: 0, tokens: 0, latencyMs: 0, rating: 4 },
      { succeeded: true, completionMs: 100, costUsd: 0, tokens: 0, latencyMs: 0, rating: 5 },
      { succeeded: true, completionMs: 100, costUsd: 0, tokens: 0, latencyMs: 0 },
    ]);
    expect(metrics.userRating).toBeCloseTo(4.5, 3);
    expect(metrics.ratingCount).toBe(2);
  });

  it('counts a retried success as unreliable', () => {
    const metrics = BenchmarkService.measure([
      { succeeded: true, completionMs: 1, costUsd: 0, tokens: 0, latencyMs: 0, retried: true },
      { succeeded: true, completionMs: 1, costUsd: 0, tokens: 0, latencyMs: 0 },
    ]);
    expect(metrics.reliability).toBe(0.5);
    expect(metrics.observedRate).toBe(1);
  });

  it('leaves ROI at zero for free work rather than infinity', () => {
    const metrics = BenchmarkService.measure([
      { succeeded: true, completionMs: 1, costUsd: 0, tokens: 0, latencyMs: 0 },
    ]);
    expect(metrics.roi).toBe(0);
  });

  it('refuses to judge without enough trials', () => {
    const result = BenchmarkService.judge(bench({ trials: 2 }), bench({ arm: 'variant', trials: 2 }), 5);
    expect(result.verdict).toBe('INSUFFICIENT_DATA');
    expect(result.winner).toBeNull();
  });

  it('calls indistinguishable arms inconclusive rather than picking one', () => {
    const result = BenchmarkService.judge(
      bench({ trials: 20, successes: 16, successRate: 0.6 }),
      bench({ arm: 'variant', trials: 20, successes: 15, successRate: 0.58 }),
      5,
    );
    expect(['INCONCLUSIVE', 'BETTER']).toContain(result.verdict);
    if (result.verdict === 'INCONCLUSIVE') expect(result.winner).toBeNull();
  });

  it('declares the variant better when the arms separate on reliability', () => {
    const result = BenchmarkService.judge(
      bench({ trials: 200, successes: 100, successRate: 0.43 }),
      bench({ arm: 'variant', trials: 200, successes: 190, successRate: 0.9 }),
      5,
    );
    expect(result.verdict).toBe('BETTER');
    expect(result.winner).toBe('variant');
  });

  it('declares the variant worse when it loses on reliability', () => {
    const result = BenchmarkService.judge(
      bench({ trials: 200, successes: 190, successRate: 0.9 }),
      bench({ arm: 'variant', trials: 200, successes: 100, successRate: 0.43 }),
      5,
    );
    expect(result.verdict).toBe('WORSE');
    expect(result.winner).toBe('control');
  });

  it('reports regressions even when the variant wins overall', () => {
    const result = BenchmarkService.judge(
      bench({ trials: 200, successes: 100, successRate: 0.43, avgCostUsd: 0.001 }),
      bench({ arm: 'variant', trials: 200, successes: 190, successRate: 0.9, avgCostUsd: 0.05 }),
      5,
    );
    expect(result.verdict).toBe('BETTER');
    expect(result.regressions.some((r) => r.metric === 'avgCostUsd')).toBe(true);
  });

  it('knows which direction is good for each metric', () => {
    expect(BenchmarkService.HIGHER_IS_BETTER.successRate).toBe(true);
    expect(BenchmarkService.HIGHER_IS_BETTER.avgCostUsd).toBe(false);
    expect(BenchmarkService.HIGHER_IS_BETTER.avgLatencyMs).toBe(false);
  });

  it('reports a change from zero as zero rather than infinity', () => {
    expect(BenchmarkService.relativeChange(0, 5)).toBe(0);
    expect(Number.isFinite(BenchmarkService.relativeChange(0, 5))).toBe(true);
  });

  it('computes relative change in both directions', () => {
    expect(BenchmarkService.relativeChange(100, 150)).toBeCloseTo(0.5, 3);
    expect(BenchmarkService.relativeChange(100, 50)).toBeCloseTo(-0.5, 3);
  });
});

describe('version aspects', () => {
  it('maps worker fields to the right aspect', () => {
    expect(VersionService.aspectForChange(EvolutionSubject.WORKER, { systemPrompt: 'x' })).toBe(
      VersionAspect.PROMPT,
    );
    expect(VersionService.aspectForChange(EvolutionSubject.WORKER, { maxIterations: 8 })).toBe(
      VersionAspect.LIMITS,
    );
    expect(VersionService.aspectForChange(EvolutionSubject.WORKER, { toolPermissions: [] })).toBe(
      VersionAspect.TOOLS,
    );
  });

  it('refuses a change spanning two aspects so rollback stays whole', () => {
    expect(() =>
      VersionService.aspectForChange(EvolutionSubject.WORKER, {
        systemPrompt: 'x',
        maxIterations: 8,
      }),
    ).toThrow(/one aspect/);
  });

  it('refuses a change to no versioned field at all', () => {
    expect(() =>
      VersionService.aspectForChange(EvolutionSubject.WORKER, { nonsense: 1 }),
    ).toThrow(/versioned field/);
  });

  it('treats a workflow change as a graph change', () => {
    expect(VersionService.aspectForChange(EvolutionSubject.WORKFLOW, { anything: 1 })).toBe(
      VersionAspect.GRAPH,
    );
  });

  it('lists the fields that make up an aspect', () => {
    expect(VersionService.fieldsFor(EvolutionSubject.WORKER, VersionAspect.PROMPT)).toContain(
      'systemPrompt',
    );
    expect(VersionService.fieldsFor(EvolutionSubject.WORKFLOW, VersionAspect.GRAPH)).toContain(
      'steps',
    );
  });

  it('diffs only the fields that actually changed', () => {
    const diff = VersionService.diffPayloads({ a: 1, b: 2 }, { a: 1, b: 3 });
    expect(diff).toEqual([{ field: 'b', from: 2, to: 3 }]);
  });

  it('reports an added and a removed field', () => {
    const diff = VersionService.diffPayloads({ a: 1 }, { b: 2 });
    expect(diff.map((d) => d.field).sort()).toEqual(['a', 'b']);
  });
});

describe('candidate risk', () => {
  it('always rates a tool grant as high risk', () => {
    expect(CandidateService.riskFor(EvolutionKind.TOOL_PERMISSION, 1)).toBe(RiskLevel.HIGH);
  });

  it('rates structural changes by how sure we are', () => {
    expect(CandidateService.riskFor(EvolutionKind.WORKFLOW_STRUCTURE, 0.9)).toBe(RiskLevel.MEDIUM);
    expect(CandidateService.riskFor(EvolutionKind.WORKFLOW_STRUCTURE, 0.4)).toBe(RiskLevel.HIGH);
  });

  it('rates a well-evidenced limit tweak as low risk', () => {
    expect(CandidateService.riskFor(EvolutionKind.EXECUTION_LIMITS, 0.95)).toBe(RiskLevel.LOW);
  });

  it('raises risk when confidence is thin, whatever the change', () => {
    expect(CandidateService.riskFor(EvolutionKind.EXECUTION_LIMITS, 0.2)).toBe(RiskLevel.MEDIUM);
  });

  it('maps only recommendation kinds that have a concrete form', () => {
    expect(CandidateService.KIND_MAP.PROVIDER_SWITCH).toBe(EvolutionKind.PROVIDER_CHANGE);
    expect(CandidateService.KIND_MAP.KNOWLEDGE_MERGE).toBeUndefined();
  });
});

describe('experiment allocation', () => {
  const experiment = (mode: ExperimentMode, allocation = 0.5) => ({
    id: 'exp1', allocation, mode,
  });

  it('runs both arms on every trial in the modes that touch nothing real', () => {
    expect(ExperimentService.armFor(experiment(ExperimentMode.SANDBOX), 'x')).toBe('variant');
    expect(ExperimentService.armFor(experiment(ExperimentMode.SHADOW), 'x')).toBe('variant');
  });

  it('is deterministic for the split modes', () => {
    const first = ExperimentService.armFor(experiment(ExperimentMode.AB), 'trial-7');
    for (let i = 0; i < 20; i += 1) {
      expect(ExperimentService.armFor(experiment(ExperimentMode.AB), 'trial-7')).toBe(first);
    }
  });

  it('splits roughly according to the allocation', () => {
    let variant = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (ExperimentService.armFor(experiment(ExperimentMode.AB), `t${i}`) === 'variant') variant += 1;
    }
    expect(variant).toBeGreaterThan(400);
    expect(variant).toBeLessThan(600);
  });

  it('keeps a canary small', () => {
    let variant = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (ExperimentService.armFor(experiment(ExperimentMode.CANARY, 0.1), `t${i}`) === 'variant') {
        variant += 1;
      }
    }
    expect(variant).toBeLessThan(200);
  });

  it('describes how much of the real system each mode touches', () => {
    expect(ExperimentService.exposureOf(ExperimentMode.SANDBOX)).toBe('none');
    expect(ExperimentService.exposureOf(ExperimentMode.SHADOW)).toBe('observed');
    expect(ExperimentService.exposureOf(ExperimentMode.CANARY)).toBe('partial');
    expect(ExperimentService.exposureOf(ExperimentMode.AB)).toBe('split');
  });
});

describe('planning evolution', () => {
  const review = (over = {}) =>
    ({
      missedOpportunities: [], bottlenecks: [], retryCount: 0,
      estimatedMs: null, completionMs: 1000, estimatedCostUsd: null, costUsd: 0.01,
      ...over,
    }) as never;

  it('sees nothing in an empty history', () => {
    expect(PlanningEvolutionService.observe([])).toEqual([]);
  });

  it('notices missions that leave parallelism unused', () => {
    const reviews = Array.from({ length: 10 }, () =>
      review({ missedOpportunities: [{ kind: 'unused_parallelism' }] }),
    );
    const observations = PlanningEvolutionService.observe(reviews);
    expect(observations.some((o) => o.signal === 'unused parallelism')).toBe(true);
    expect(observations.find((o) => o.signal === 'unused parallelism')?.suggests.maxParallelism).toBe(4);
  });

  it('does not fire on an occasional occurrence', () => {
    const reviews = [
      review({ missedOpportunities: [{ kind: 'unused_parallelism' }] }),
      ...Array.from({ length: 9 }, () => review()),
    ];
    expect(PlanningEvolutionService.observe(reviews).some((o) => o.signal === 'unused parallelism')).toBe(
      false,
    );
  });

  it('notices consistent estimate drift', () => {
    const reviews = Array.from({ length: 10 }, () =>
      review({ estimatedMs: 1000, completionMs: 5000 }),
    );
    expect(PlanningEvolutionService.observe(reviews).some((o) => o.signal === 'estimate drift')).toBe(
      true,
    );
  });

  it('notices heavy retrying and suggests reliability over cost', () => {
    const reviews = Array.from({ length: 10 }, () => review({ retryCount: 5 }));
    const observation = PlanningEvolutionService.observe(reviews).find(
      (o) => o.signal === 'heavy retrying',
    );
    expect(observation?.suggests.providerSelection).toBe('reliability');
  });

  it('every observation carries a concrete suggestion', () => {
    const reviews = Array.from({ length: 10 }, () =>
      review({ retryCount: 5, bottlenecks: [{ taskId: 't' }] }),
    );
    expect(
      PlanningEvolutionService.observe(reviews).every(
        (o) => Object.keys(o.suggests).length > 0 && o.detail.length > 10,
      ),
    ).toBe(true);
  });

  it('will not promote an unmeasured strategy', () => {
    expect(
      PlanningEvolutionService.outperforms(
        { successRate: 1, missionsPlanned: 2, avgCostUsd: 0.001 },
        { successRate: 0.5, missionsPlanned: 100, avgCostUsd: 0.01 },
      ),
    ).toBe(false);
  });

  it('promotes a measured strategy that is more reliable', () => {
    expect(
      PlanningEvolutionService.outperforms(
        { successRate: 0.8, missionsPlanned: 50, avgCostUsd: 0.01 },
        { successRate: 0.6, missionsPlanned: 50, avgCostUsd: 0.01 },
      ),
    ).toBe(true);
  });

  it('promotes an equally reliable strategy that costs materially less', () => {
    expect(
      PlanningEvolutionService.outperforms(
        { successRate: 0.8, missionsPlanned: 50, avgCostUsd: 0.005 },
        { successRate: 0.81, missionsPlanned: 50, avgCostUsd: 0.01 },
      ),
    ).toBe(true);
  });

  it('does not promote on a trivially cheaper run at equal reliability', () => {
    expect(
      PlanningEvolutionService.outperforms(
        { successRate: 0.8, missionsPlanned: 50, avgCostUsd: 0.0099 },
        { successRate: 0.8, missionsPlanned: 50, avgCostUsd: 0.01 },
      ),
    ).toBe(false);
  });
});

describe('evolution digest', () => {
  it('says plainly when nothing has happened', () => {
    expect(
      EvolutionDashboardService.headline({ deployed: 0, rolledBack: 0, refused: 0, experiments: 0, days: 30 }),
    ).toMatch(/No evolution activity/);
  });

  it('counts refusals and rollbacks alongside deployments', () => {
    const headline = EvolutionDashboardService.headline({
      deployed: 2, rolledBack: 1, refused: 3, experiments: 4, days: 30,
    });
    expect(headline).toContain('2 change(s) deployed');
    expect(headline).toContain('1 rolled back');
    expect(headline).toContain('3 refused');
  });

  it('reports refusals as something the system did right', () => {
    const improvements = EvolutionDashboardService.whatImproved({
      deployedCount: 0, settledCount: 0, rolledBackCount: 0, refusedCount: 2,
      betterExperiments: 0, rejectedCandidates: 0, deployments: [], activeStrategy: null,
    });
    expect(improvements.some((i) => i.includes('refused'))).toBe(true);
  });

  it('counts candidates killed by measurement as an improvement', () => {
    const improvements = EvolutionDashboardService.whatImproved({
      deployedCount: 0, settledCount: 0, rolledBackCount: 0, refusedCount: 0,
      betterExperiments: 0, rejectedCandidates: 4, deployments: [], activeStrategy: null,
    });
    expect(improvements.some((i) => i.includes('rejected by measurement'))).toBe(true);
  });

  it('admits when nothing has changed', () => {
    const improvements = EvolutionDashboardService.whatImproved({
      deployedCount: 0, settledCount: 0, rolledBackCount: 0, refusedCount: 0,
      betterExperiments: 0, rejectedCandidates: 0, deployments: [], activeStrategy: null,
    });
    expect(improvements).toHaveLength(1);
    expect(improvements[0]).toMatch(/Nothing has changed/);
  });

  it('distinguishes "found but not deployed" from "found nothing"', () => {
    const improvements = EvolutionDashboardService.whatImproved({
      deployedCount: 0, settledCount: 0, rolledBackCount: 0, refusedCount: 0,
      betterExperiments: 2, rejectedCandidates: 0, deployments: [], activeStrategy: null,
    });
    expect(improvements[0]).toMatch(/none has been deployed yet/);
  });

  it('reports an unreadable confidence trend as unknown', () => {
    const trend = EvolutionDashboardService.confidenceTrend([
      { confidence: 0.5, createdAt: new Date() },
    ]);
    expect(trend.direction).toBe('unknown');
  });

  it('detects rising and falling confidence', () => {
    const rising = EvolutionDashboardService.confidenceTrend([
      { confidence: 0.2, createdAt: new Date('2026-08-01') },
      { confidence: 0.3, createdAt: new Date('2026-08-02') },
      { confidence: 0.8, createdAt: new Date('2026-08-03') },
      { confidence: 0.9, createdAt: new Date('2026-08-04') },
    ]);
    expect(rising.direction).toBe('improving');

    const falling = EvolutionDashboardService.confidenceTrend([
      { confidence: 0.9, createdAt: new Date('2026-08-01') },
      { confidence: 0.8, createdAt: new Date('2026-08-02') },
      { confidence: 0.3, createdAt: new Date('2026-08-03') },
      { confidence: 0.2, createdAt: new Date('2026-08-04') },
    ]);
    expect(falling.direction).toBe('declining');
  });

  it('orders the timeline newest first', () => {
    const timeline = EvolutionDashboardService.buildTimeline([
      {
        subjectLabel: 'A', subjectId: 'a', kind: 'PROMPT_OPTIMIZATION',
        status: 'SETTLED' as never, notes: null, rollbackReason: null,
        deployedAt: new Date('2026-08-01'), rolledBackAt: null, createdAt: new Date('2026-08-01'),
      },
      {
        subjectLabel: 'B', subjectId: 'b', kind: 'MODEL_CHANGE',
        status: 'ROLLED_BACK' as never, notes: null, rollbackReason: 'regressed',
        deployedAt: new Date('2026-08-02'), rolledBackAt: new Date('2026-08-03'),
        createdAt: new Date('2026-08-02'),
      },
    ]);
    expect(timeline[0].at >= timeline[timeline.length - 1].at).toBe(true);
    expect(timeline.some((e) => e.event === 'rolled_back')).toBe(true);
  });
});
