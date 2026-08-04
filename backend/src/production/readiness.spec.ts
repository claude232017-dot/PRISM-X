import {
  DIMENSIONS,
  READINESS_CHECKS,
  READINESS_VERSION,
  describeChecks,
  review,
} from './readiness';
import type { Environment, ReadinessEvidence } from './readiness';

/** Evidence for a system that would pass everything. Tests override one field. */
const healthy = (overrides: Partial<ReadinessEvidence> = {}): ReadinessEvidence => ({
  environment: 'production' as Environment,
  config: {
    secretsFromEnvironment: true,
    defaultSecretsInUse: [],
    corsOrigins: ['https://app.example'],
    trustProxy: true,
  },
  instances: { healthy: 3, leader: 'host-a', stateless: true },
  database: {
    reachable: true,
    appliedMigrations: 19,
    pendingMigrations: 0,
    rlsTables: 84,
    tenantTables: 65,
  },
  cache: { reachable: true },
  queues: { reachable: true, deadLetters: 0 },
  backups: {
    lastSucceededAt: new Date(Date.now() - 3_600_000),
    lastVerifiedAt: new Date(Date.now() - 86_400_000),
    allEncrypted: true,
    count: 6,
    restoreTested: true,
  },
  security: {
    administrators: 2,
    administratorsWithMfa: 2,
    oldestKeyAgeDays: 30,
    staleApiKeys: 0,
    rateLimitingActive: true,
    securityHeadersActive: true,
    vulnerableDependencies: 0,
  },
  observability: {
    metricsExposed: true,
    tracingEnabled: true,
    healthProbes: ['liveness', 'readiness', 'deep'],
    alertRules: 8,
    firingAlerts: 0,
  },
  performance: { p95Ms: 120, errorRate: 0.001, sampleCount: 500 },
  documentation: { apiOperations: 380, runbooks: 4 },
  quality: { suites: 8, gatesDeployment: true, lastRunPassed: true },
  ...overrides,
});

const outcomeOf = (evidence: ReadinessEvidence, id: string) =>
  review(evidence).verdicts.find((verdict) => verdict.id === id)?.outcome;

describe('the readiness bar', () => {
  it('is frozen, so the system cannot lower its own bar', () => {
    expect(Object.isFrozen(READINESS_CHECKS)).toBe(true);
    expect(READINESS_CHECKS.every((check) => Object.isFrozen(check))).toBe(true);
    expect(() => {
      (READINESS_CHECKS as unknown as unknown[]).push({});
    }).toThrow();
  });

  it('covers every dimension the review is meant to audit', () => {
    for (const dimension of DIMENSIONS) {
      expect(READINESS_CHECKS.some((check) => check.dimension === dimension)).toBe(true);
    }
  });

  it('gives every check a statement and a reason to exist', () => {
    for (const check of describeChecks()) {
      expect(check.statement.endsWith('.')).toBe(true);
      expect(check.rationale.length).toBeGreaterThan(40);
      expect(['BLOCKER', 'REQUIRED', 'ADVISORY']).toContain(check.severity);
    }
  });

  it('has a version derived from the bar itself', () => {
    expect(READINESS_VERSION).toHaveLength(16);
  });

  it('has unique identifiers', () => {
    const ids = READINESS_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('review', () => {
  it('passes a healthy production system', () => {
    const result = review(healthy());
    expect(result.readyForProduction).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.summary.FAIL).toBe(0);
  });

  it('grades every check without short-circuiting on the first failure', () => {
    const result = review(
      healthy({
        database: {
          reachable: true,
          appliedMigrations: 19,
          pendingMigrations: 3,
          rlsTables: 10,
          tenantTables: 65,
        },
      }),
    );
    expect(result.verdicts).toHaveLength(READINESS_CHECKS.length);
    // Both database failures are reported, not only the first — a review that
    // stopped at the first failure would turn one audit into a queue of them.
    const failed = result.verdicts.filter((v) => v.outcome === 'FAIL').map((v) => v.id);
    expect(failed).toEqual(expect.arrayContaining(['MIGRATIONS_SETTLED', 'TENANT_ISOLATION_COMPLETE']));
  });

  it('lets any failing blocker decide production readiness', () => {
    const result = review(healthy({ backups: { ...healthy().backups, lastSucceededAt: null } }));
    expect(result.readyForProduction).toBe(false);
    expect(result.blockers.map((b) => b.id)).toContain('RECENT_BACKUP');
  });

  it('does not let a failing REQUIRED check block production', () => {
    const result = review(healthy({ security: { ...healthy().security, staleApiKeys: 4 } }));
    expect(outcomeOf(healthy({ security: { ...healthy().security, staleApiKeys: 4 } }), 'NO_STALE_CREDENTIALS')).toBe('FAIL');
    expect(result.readyForProduction).toBe(true);
  });

  it('excludes what it could not measure from the score', () => {
    const blind = review(
      healthy({
        performance: { p95Ms: null, errorRate: null, sampleCount: 0 },
        security: { ...healthy().security, vulnerableDependencies: null },
      }),
    );
    expect(blind.summary.UNKNOWN).toBeGreaterThanOrEqual(3);
    // An unmeasured system should not score like an unhealthy one.
    expect(blind.score).toBeGreaterThan(0.9);
  });

  it('rolls a dimension up to its worst check', () => {
    const result = review(healthy({ queues: { reachable: true, deadLetters: 500 } }));
    const reliability = result.dimensions.find((d) => d.dimension === 'RELIABILITY');
    expect(reliability?.outcome).toBe('FAIL');
  });
});

describe('environment sensitivity', () => {
  it('blocks a wildcard CORS origin in production', () => {
    const evidence = healthy({ config: { ...healthy().config, corsOrigins: ['*'] } });
    expect(outcomeOf(evidence, 'CORS_NOT_WILDCARD')).toBe('FAIL');
    expect(review(evidence).readyForProduction).toBe(false);
  });

  it('warns rather than blocks outside production', () => {
    const evidence = healthy({
      environment: 'development',
      config: { ...healthy().config, corsOrigins: ['*'] },
    });
    expect(outcomeOf(evidence, 'CORS_NOT_WILDCARD')).toBe('WARN');
    expect(review(evidence).readyForProduction).toBe(true);
  });

  it('requires redundancy in production and merely notes it elsewhere', () => {
    expect(outcomeOf(healthy({ instances: { healthy: 1, leader: 'a', stateless: true } }), 'REDUNDANT_INSTANCES')).toBe('FAIL');
    expect(
      outcomeOf(
        healthy({ environment: 'staging', instances: { healthy: 1, leader: 'a', stateless: true } }),
        'REDUNDANT_INSTANCES',
      ),
    ).toBe('WARN');
  });
});

describe('individual checks', () => {
  it('fails tenant isolation when a table needing a policy lacks one', () => {
    expect(
      outcomeOf(
        healthy({
          database: { ...healthy().database, rlsTables: 60, tenantTables: 65 },
        }),
        'TENANT_ISOLATION_COMPLETE',
      ),
    ).toBe('FAIL');
  });

  it('abstains on tenant isolation when the database is unreachable', () => {
    expect(
      outcomeOf(
        healthy({
          database: { reachable: false, appliedMigrations: 0, pendingMigrations: 0, rlsTables: 0, tenantTables: 0 },
        }),
        'TENANT_ISOLATION_COMPLETE',
      ),
    ).toBe('UNKNOWN');
  });

  it('fails when instances are running with no leader', () => {
    expect(
      outcomeOf(healthy({ instances: { healthy: 3, leader: null, stateless: true } }), 'SCHEDULED_WORK_ELECTED'),
    ).toBe('FAIL');
  });

  it('abstains on latency and error rate below a usable sample size', () => {
    const thin = healthy({ performance: { p95Ms: 8000, errorRate: 0.5, sampleCount: 4 } });
    expect(outcomeOf(thin, 'LATENCY_BUDGET')).toBe('UNKNOWN');
    expect(outcomeOf(thin, 'ERROR_RATE')).toBe('UNKNOWN');
  });

  it('grades latency and error rate once there is enough data', () => {
    expect(outcomeOf(healthy({ performance: { p95Ms: 8000, errorRate: 0.5, sampleCount: 500 } }), 'LATENCY_BUDGET')).toBe('FAIL');
    expect(outcomeOf(healthy({ performance: { p95Ms: 1500, errorRate: 0.02, sampleCount: 500 } }), 'LATENCY_BUDGET')).toBe('WARN');
    expect(outcomeOf(healthy({ performance: { p95Ms: 1500, errorRate: 0.02, sampleCount: 500 } }), 'ERROR_RATE')).toBe('WARN');
  });

  it('treats backup age on a sliding scale', () => {
    const at = (hours: number) =>
      outcomeOf(
        healthy({ backups: { ...healthy().backups, lastSucceededAt: new Date(Date.now() - hours * 3_600_000) } }),
        'RECENT_BACKUP',
      );
    expect(at(1)).toBe('PASS');
    expect(at(48)).toBe('WARN');
    expect(at(24 * 10)).toBe('FAIL');
  });

  it('abstains on encryption when there is nothing to encrypt', () => {
    expect(
      outcomeOf(healthy({ backups: { ...healthy().backups, count: 0 } }), 'BACKUPS_ENCRYPTED'),
    ).toBe('UNKNOWN');
  });

  it('separates "we have not scanned" from "we scanned and found nothing"', () => {
    expect(outcomeOf(healthy({ security: { ...healthy().security, vulnerableDependencies: null } }), 'DEPENDENCY_ADVISORIES')).toBe('UNKNOWN');
    expect(outcomeOf(healthy({ security: { ...healthy().security, vulnerableDependencies: 0 } }), 'DEPENDENCY_ADVISORIES')).toBe('PASS');
    expect(outcomeOf(healthy({ security: { ...healthy().security, vulnerableDependencies: 2 } }), 'DEPENDENCY_ADVISORIES')).toBe('FAIL');
  });

  it('requires both liveness and readiness probes', () => {
    expect(
      outcomeOf(
        healthy({ observability: { ...healthy().observability, healthProbes: ['liveness'] } }),
        'HEALTH_PROBES',
      ),
    ).toBe('FAIL');
  });

  it('warns when alerts are configured and firing', () => {
    expect(
      outcomeOf(healthy({ observability: { ...healthy().observability, firingAlerts: 2 } }), 'ALERTING'),
    ).toBe('WARN');
  });

  it('fails a config still holding a shipped default', () => {
    expect(
      outcomeOf(
        healthy({ config: { ...healthy().config, defaultSecretsInUse: ['JWT_SECRET'] } }),
        'CONFIG_FROM_ENVIRONMENT',
      ),
    ).toBe('FAIL');
  });
});
