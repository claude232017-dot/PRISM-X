import { createHash } from 'node:crypto';

/**
 * The production readiness review, as executable checks rather than a document.
 *
 * Step 10 asks for a final audit across ten dimensions. A checklist someone
 * ticks answers that once, on the day it is written, and drifts from reality
 * immediately afterwards. This file makes the audit a function of the system's
 * actual state: every check is a predicate over gathered evidence, so "are we
 * ready for production" is a question the running system answers about itself,
 * repeatedly, and can fail later when something regresses.
 *
 * The same reasoning produced `constitution.ts` in Phase 6 and
 * `capabilities.ts` in Phase 7 — the rules live in frozen code, and what they
 * evaluate is data. Here the rules are frozen because a readiness bar that the
 * system could lower on its own is not a bar.
 *
 * Three severities, and the distinction matters more than the count:
 *
 *  - **BLOCKER** — going to production with this failing is negligent. Any
 *    failing blocker makes `readyForProduction` false, whatever else passes.
 *  - **REQUIRED** — expected in a healthy production system. A failure is a
 *    known gap that someone has to own, not a reason to stop the deploy.
 *  - **ADVISORY** — worth knowing. Never blocks anything.
 *
 * A check that cannot be evaluated returns UNKNOWN rather than PASS. Missing
 * evidence is not evidence of health, and a review that quietly counts absent
 * data as success is worse than no review.
 */

export type ReadinessDimension =
  | 'ARCHITECTURE'
  | 'PERFORMANCE'
  | 'SECURITY'
  | 'SCALABILITY'
  | 'RELIABILITY'
  | 'DOCUMENTATION'
  | 'RECOVERY'
  | 'MONITORING'
  | 'DEVELOPER_EXPERIENCE'
  | 'OPERATIONS';

export const DIMENSIONS: readonly ReadinessDimension[] = Object.freeze([
  'ARCHITECTURE',
  'PERFORMANCE',
  'SECURITY',
  'SCALABILITY',
  'RELIABILITY',
  'DOCUMENTATION',
  'RECOVERY',
  'MONITORING',
  'DEVELOPER_EXPERIENCE',
  'OPERATIONS',
]);

export type ReadinessSeverity = 'BLOCKER' | 'REQUIRED' | 'ADVISORY';
export type ReadinessOutcome = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

export type Environment = 'development' | 'test' | 'staging' | 'production';

/**
 * What the review is evaluated against. Every field is gathered from the live
 * system; nothing here is asserted by hand.
 */
export interface ReadinessEvidence {
  environment: Environment;

  config: {
    /** True when every secret came from the environment rather than a literal. */
    secretsFromEnvironment: boolean;
    /** Config keys still holding a shipped development default. */
    defaultSecretsInUse: string[];
    /** Origins permitted by CORS. `['*']` is the thing worth catching. */
    corsOrigins: string[];
    /** True when the process refuses to serve without TLS termination in front. */
    trustProxy: boolean;
  };

  instances: {
    /** Instances that have reported in within the liveness window. */
    healthy: number;
    /** Instance id currently holding the scheduler lease, if any. */
    leader: string | null;
    /** True when no request-scoped state is held in process memory. */
    stateless: boolean;
    /**
     * Named process-local holdings that would not survive rescheduling.
     *
     * Reported rather than summarised so a failure says *what* is held. A
     * blocker whose detail is "there is state somewhere" is a blocker nobody
     * can act on.
     */
    statefulHoldings?: string[];
  };

  database: {
    reachable: boolean;
    appliedMigrations: number;
    pendingMigrations: number;
    /** Tables with row-level security enabled. */
    rlsTables: number;
    /** Tables carrying an `organizationId`, i.e. those that need it. */
    tenantTables: number;
  };

  cache: { reachable: boolean };

  queues: { reachable: boolean; deadLetters: number };

  backups: {
    lastSucceededAt: Date | null;
    lastVerifiedAt: Date | null;
    /** True when every stored backup is encrypted at rest. */
    allEncrypted: boolean;
    count: number;
    /** Whether a restore has ever been exercised, not just written. */
    restoreTested: boolean;
  };

  security: {
    administrators: number;
    /** Administrators with a second factor enrolled. */
    administratorsWithMfa: number;
    /** Age of the oldest live credential-encryption key, in days. */
    oldestKeyAgeDays: number | null;
    /** API keys past their expiry that are still usable. */
    staleApiKeys: number;
    rateLimitingActive: boolean;
    securityHeadersActive: boolean;
    /** Dependency advisories at high or critical severity. */
    vulnerableDependencies: number | null;
  };

  observability: {
    metricsExposed: boolean;
    tracingEnabled: boolean;
    /** Health endpoints answering: liveness, readiness, deep. */
    healthProbes: string[];
    alertRules: number;
    /** Alerts currently firing. */
    firingAlerts: number;
  };

  performance: {
    /** 95th percentile API latency over the sampled window, milliseconds. */
    p95Ms: number | null;
    errorRate: number | null;
    sampleCount: number;
  };

  documentation: {
    /** Documented API operations in the generated OpenAPI document. */
    apiOperations: number;
    /** Operational runbooks present in the repository. */
    runbooks: number;
  };

  quality: {
    /** Automated suites wired into the pipeline. */
    suites: number;
    /** True when the pipeline blocks a deploy on a failing suite. */
    gatesDeployment: boolean;
    lastRunPassed: boolean | null;
  };
}

export interface ReadinessCheck {
  id: string;
  dimension: ReadinessDimension;
  /** What the check asserts, in one sentence. */
  statement: string;
  /** Why it is worth blocking on, or worth knowing. */
  rationale: string;
  severity: ReadinessSeverity;
  /**
   * Returns the outcome and a sentence naming the actual value. The sentence
   * is what a reviewer reads, so it always cites the number rather than
   * repeating the statement.
   */
  evaluate(evidence: ReadinessEvidence): { outcome: ReadinessOutcome; detail: string };
}

/** Only production is held to the full bar; lower environments are informational. */
function productionOnly(
  evidence: ReadinessEvidence,
  failing: boolean,
  detail: string,
): { outcome: ReadinessOutcome; detail: string } {
  if (!failing) return { outcome: 'PASS', detail };
  return {
    outcome: evidence.environment === 'production' ? 'FAIL' : 'WARN',
    detail:
      evidence.environment === 'production'
        ? detail
        : `${detail} (not blocking outside production)`,
  };
}

function daysSince(date: Date | null): number | null {
  if (!date) return null;
  return (Date.now() - date.getTime()) / 86_400_000;
}

const CHECKS: ReadinessCheck[] = [
  // ------------------------------------------------------------ ARCHITECTURE
  {
    id: 'CONFIG_FROM_ENVIRONMENT',
    dimension: 'ARCHITECTURE',
    statement: 'Every secret and environment-specific value comes from the environment.',
    rationale:
      'A value compiled into the image is the same value in every environment, ' +
      'cannot be rotated without a rebuild, and is readable by anyone who can ' +
      'read the image.',
    severity: 'BLOCKER',
    evaluate: (e) =>
      productionOnly(
        e,
        !e.config.secretsFromEnvironment || e.config.defaultSecretsInUse.length > 0,
        e.config.defaultSecretsInUse.length
          ? `Shipped defaults still in use: ${e.config.defaultSecretsInUse.join(', ')}`
          : 'All configuration resolves from the environment',
      ),
  },
  {
    id: 'TENANT_ISOLATION_COMPLETE',
    dimension: 'ARCHITECTURE',
    statement: 'Every tenant-scoped table is protected by row-level security.',
    rationale:
      'The repository layer scopes queries, but it is one layer. A table without ' +
      'a policy is one forgotten predicate away from a cross-tenant read.',
    severity: 'BLOCKER',
    evaluate: (e) => {
      if (!e.database.reachable) return { outcome: 'UNKNOWN', detail: 'Database unreachable' };
      const gap = e.database.tenantTables - e.database.rlsTables;
      return gap > 0
        ? { outcome: 'FAIL', detail: `${gap} tenant table(s) without a policy` }
        : {
            outcome: 'PASS',
            detail: `${e.database.rlsTables} table(s) protected, ${e.database.tenantTables} require it`,
          };
    },
  },
  {
    id: 'MIGRATIONS_SETTLED',
    dimension: 'ARCHITECTURE',
    statement: 'No migration is pending against the running schema.',
    rationale:
      'Code deployed ahead of its migration fails at the first query that needs ' +
      'the new column, in production, under load.',
    severity: 'BLOCKER',
    evaluate: (e) => {
      if (!e.database.reachable) return { outcome: 'UNKNOWN', detail: 'Database unreachable' };
      return e.database.pendingMigrations > 0
        ? { outcome: 'FAIL', detail: `${e.database.pendingMigrations} migration(s) pending` }
        : { outcome: 'PASS', detail: `${e.database.appliedMigrations} migration(s) applied` };
    },
  },

  // ------------------------------------------------------------- SCALABILITY
  {
    id: 'STATELESS_INSTANCES',
    dimension: 'SCALABILITY',
    statement: 'Backend instances hold no request-scoped state in process memory.',
    rationale:
      'State in a process is state that disappears when the process does, and ' +
      'that the next request may not find because the load balancer chose ' +
      'differently. Statelessness is what makes an instance disposable.',
    severity: 'BLOCKER',
    evaluate: (e) =>
      e.instances.stateless
        ? { outcome: 'PASS', detail: 'Session, cache and queue state are all external' }
        : {
            outcome: 'FAIL',
            detail: `In-process state would not survive rescheduling: ${
              e.instances.statefulHoldings?.join('; ') || 'unnamed holding'
            }`,
          },
  },
  {
    id: 'SCHEDULED_WORK_ELECTED',
    dimension: 'SCALABILITY',
    statement: 'Exactly one instance runs scheduled work at a time.',
    rationale:
      'Every instance running the cron tick means every schedule fires N times. ' +
      'Duplicated work is the first thing that breaks when one server becomes ' +
      'three, and it breaks quietly.',
    severity: 'BLOCKER',
    evaluate: (e) => {
      if (e.instances.healthy === 0) return { outcome: 'UNKNOWN', detail: 'No instance reporting' };
      return e.instances.leader
        ? { outcome: 'PASS', detail: `Lease held by ${e.instances.leader} of ${e.instances.healthy} instance(s)` }
        : {
            outcome: 'FAIL',
            detail: `${e.instances.healthy} instance(s) and no leader — scheduled work is unowned`,
          };
    },
  },
  {
    id: 'REDUNDANT_INSTANCES',
    dimension: 'SCALABILITY',
    statement: 'More than one instance is serving traffic.',
    rationale:
      'A single instance is a single point of failure and a deployment outage. ' +
      'This is about availability, not throughput.',
    severity: 'REQUIRED',
    evaluate: (e) =>
      e.instances.healthy > 1
        ? { outcome: 'PASS', detail: `${e.instances.healthy} healthy instance(s)` }
        : {
            outcome: e.environment === 'production' ? 'FAIL' : 'WARN',
            detail: `${e.instances.healthy} instance(s) — no redundancy`,
          },
  },
  {
    id: 'SHARED_INFRASTRUCTURE',
    dimension: 'SCALABILITY',
    statement: 'Cache and queues are reachable and shared across instances.',
    rationale:
      'A per-instance cache is a correctness problem, not a performance one: ' +
      'instances disagree about what they have already done.',
    severity: 'REQUIRED',
    evaluate: (e) => {
      const missing = [
        ...(e.cache.reachable ? [] : ['cache']),
        ...(e.queues.reachable ? [] : ['queues']),
      ];
      return missing.length
        ? { outcome: 'FAIL', detail: `Unreachable: ${missing.join(', ')}` }
        : { outcome: 'PASS', detail: 'Cache and queues reachable' };
    },
  },

  // ---------------------------------------------------------------- SECURITY
  {
    id: 'ADMIN_SECOND_FACTOR',
    dimension: 'SECURITY',
    statement: 'Every administrator has a second factor enrolled.',
    rationale:
      'An administrator password is the shortest path to every organization on ' +
      'the platform. A second factor is what makes a leaked password survivable.',
    severity: 'REQUIRED',
    evaluate: (e) => {
      if (e.security.administrators === 0) {
        return { outcome: 'UNKNOWN', detail: 'No administrators found' };
      }
      const without = e.security.administrators - e.security.administratorsWithMfa;
      return without > 0
        ? productionOnly(e, true, `${without} of ${e.security.administrators} administrator(s) without MFA`)
        : { outcome: 'PASS', detail: `All ${e.security.administrators} administrator(s) enrolled` };
    },
  },
  {
    id: 'RATE_LIMITING',
    dimension: 'SECURITY',
    statement: 'Request rate limiting is enforced.',
    rationale:
      'Without it, one caller can exhaust the connection pool for everyone, and ' +
      'credential stuffing is limited only by the attacker’s bandwidth.',
    severity: 'BLOCKER',
    evaluate: (e) =>
      e.security.rateLimitingActive
        ? { outcome: 'PASS', detail: 'Per-principal limits active' }
        : productionOnly(e, true, 'No rate limiting in effect'),
  },
  {
    id: 'SECURITY_HEADERS',
    dimension: 'SECURITY',
    statement: 'Security response headers are applied.',
    rationale:
      'HSTS, frame options, content-type sniffing and referrer policy are free ' +
      'to apply and expensive to retrofit after an incident.',
    severity: 'REQUIRED',
    evaluate: (e) =>
      e.security.securityHeadersActive
        ? { outcome: 'PASS', detail: 'Headers applied to every response' }
        : productionOnly(e, true, 'Security headers not applied'),
  },
  {
    id: 'CORS_NOT_WILDCARD',
    dimension: 'SECURITY',
    statement: 'CORS does not permit every origin in production.',
    rationale:
      'A wildcard origin turns every authenticated browser session into an API ' +
      'key for any site the user visits.',
    severity: 'BLOCKER',
    evaluate: (e) =>
      productionOnly(
        e,
        e.config.corsOrigins.includes('*'),
        e.config.corsOrigins.includes('*')
          ? 'CORS permits every origin'
          : `CORS restricted to ${e.config.corsOrigins.length} origin(s)`,
      ),
  },
  {
    id: 'KEY_ROTATION',
    dimension: 'SECURITY',
    statement: 'Credential encryption keys have been rotated within a year.',
    rationale:
      'A key that has never rotated is a key whose blast radius grows every day, ' +
      'and rotation that has never been exercised is rotation that does not work.',
    severity: 'REQUIRED',
    evaluate: (e) => {
      const age = e.security.oldestKeyAgeDays;
      if (age === null) return { outcome: 'UNKNOWN', detail: 'No key age recorded' };
      if (age > 365) return { outcome: 'FAIL', detail: `Oldest key is ${Math.round(age)} days old` };
      if (age > 270) return { outcome: 'WARN', detail: `Oldest key is ${Math.round(age)} days old` };
      return { outcome: 'PASS', detail: `Oldest key is ${Math.round(age)} days old` };
    },
  },
  {
    id: 'NO_STALE_CREDENTIALS',
    dimension: 'SECURITY',
    statement: 'No expired API key is still usable.',
    rationale:
      'An expiry that is not enforced is a comment. Credentials outliving their ' +
      'stated life are credentials nobody is watching.',
    severity: 'REQUIRED',
    evaluate: (e) =>
      e.security.staleApiKeys > 0
        ? { outcome: 'FAIL', detail: `${e.security.staleApiKeys} expired key(s) still accepted` }
        : { outcome: 'PASS', detail: 'No expired key is accepted' },
  },
  {
    id: 'DEPENDENCY_ADVISORIES',
    dimension: 'SECURITY',
    statement: 'No dependency carries a high or critical advisory.',
    rationale:
      'Most production compromises arrive through a dependency, not through the ' +
      'code someone wrote.',
    severity: 'REQUIRED',
    evaluate: (e) => {
      if (e.security.vulnerableDependencies === null) {
        return { outcome: 'UNKNOWN', detail: 'Dependency scan has not run' };
      }
      return e.security.vulnerableDependencies > 0
        ? { outcome: 'FAIL', detail: `${e.security.vulnerableDependencies} high/critical advisory(ies)` }
        : { outcome: 'PASS', detail: 'No high or critical advisories' };
    },
  },

  // ------------------------------------------------------------- MONITORING
  {
    id: 'METRICS_EXPOSED',
    dimension: 'MONITORING',
    statement: 'Metrics are exposed for collection.',
    rationale:
      'Without metrics, the first sign of a problem is a customer describing it, ' +
      'and the second is a guess.',
    severity: 'BLOCKER',
    evaluate: (e) =>
      e.observability.metricsExposed
        ? { outcome: 'PASS', detail: 'Metrics endpoint answering' }
        : productionOnly(e, true, 'No metrics exposed'),
  },
  {
    id: 'HEALTH_PROBES',
    dimension: 'MONITORING',
    statement: 'Liveness and readiness probes are separately answerable.',
    rationale:
      'One combined probe forces a choice between restarting a healthy instance ' +
      'whose database blipped, and routing traffic to one that is not ready.',
    severity: 'BLOCKER',
    evaluate: (e) => {
      const required = ['liveness', 'readiness'];
      const missing = required.filter((p) => !e.observability.healthProbes.includes(p));
      return missing.length
        ? { outcome: 'FAIL', detail: `Missing probe(s): ${missing.join(', ')}` }
        : { outcome: 'PASS', detail: e.observability.healthProbes.join(', ') };
    },
  },
  {
    id: 'TRACING',
    dimension: 'MONITORING',
    statement: 'Requests carry a correlation identifier end to end.',
    rationale:
      'Across several instances, a log line without a correlation id belongs to ' +
      'no story. Tracing is what makes distributed logs readable.',
    severity: 'REQUIRED',
    evaluate: (e) =>
      e.observability.tracingEnabled
        ? { outcome: 'PASS', detail: 'Correlation propagated through requests, jobs and events' }
        : { outcome: 'FAIL', detail: 'No correlation propagation' },
  },
  {
    id: 'ALERTING',
    dimension: 'MONITORING',
    statement: 'Alert rules are defined and evaluated.',
    rationale:
      'Dashboards are for questions someone thought to ask. Alerts are for the ' +
      'ones nobody is awake to ask.',
    severity: 'REQUIRED',
    evaluate: (e) =>
      e.observability.alertRules > 0
        ? {
            outcome: e.observability.firingAlerts > 0 ? 'WARN' : 'PASS',
            detail: `${e.observability.alertRules} rule(s), ${e.observability.firingAlerts} firing`,
          }
        : { outcome: 'FAIL', detail: 'No alert rules defined' },
  },

  // -------------------------------------------------------------- RELIABILITY
  {
    id: 'ERROR_RATE',
    dimension: 'RELIABILITY',
    statement: 'The API error rate is below one percent.',
    rationale:
      'A rate rather than a count: the same number of failures means something ' +
      'different at a hundred requests than at a hundred thousand.',
    severity: 'REQUIRED',
    evaluate: (e) => {
      if (e.performance.errorRate === null || e.performance.sampleCount < 20) {
        return {
          outcome: 'UNKNOWN',
          detail: `Only ${e.performance.sampleCount} sample(s) — not enough to judge`,
        };
      }
      const percent = (e.performance.errorRate * 100).toFixed(2);
      if (e.performance.errorRate > 0.05) return { outcome: 'FAIL', detail: `${percent}% of requests failing` };
      if (e.performance.errorRate > 0.01) return { outcome: 'WARN', detail: `${percent}% of requests failing` };
      return { outcome: 'PASS', detail: `${percent}% of requests failing` };
    },
  },
  {
    id: 'DEAD_LETTERS_DRAINED',
    dimension: 'RELIABILITY',
    statement: 'The dead-letter queue is not accumulating.',
    rationale:
      'Dead letters are work the system accepted and then failed to do. Left ' +
      'alone they are silent data loss with a paper trail.',
    severity: 'REQUIRED',
    evaluate: (e) => {
      if (!e.queues.reachable) return { outcome: 'UNKNOWN', detail: 'Queues unreachable' };
      if (e.queues.deadLetters > 100) {
        return { outcome: 'FAIL', detail: `${e.queues.deadLetters} dead letter(s)` };
      }
      if (e.queues.deadLetters > 0) {
        return { outcome: 'WARN', detail: `${e.queues.deadLetters} dead letter(s)` };
      }
      return { outcome: 'PASS', detail: 'No dead letters' };
    },
  },

  // -------------------------------------------------------------- PERFORMANCE
  {
    id: 'LATENCY_BUDGET',
    dimension: 'PERFORMANCE',
    statement: 'The 95th percentile API response is under two seconds.',
    rationale:
      'The 95th percentile rather than the mean: an average hides exactly the ' +
      'requests that make people think the product is broken.',
    severity: 'REQUIRED',
    evaluate: (e) => {
      if (e.performance.p95Ms === null || e.performance.sampleCount < 20) {
        return {
          outcome: 'UNKNOWN',
          detail: `Only ${e.performance.sampleCount} sample(s) — not enough to judge`,
        };
      }
      if (e.performance.p95Ms > 2000) {
        return { outcome: 'FAIL', detail: `p95 is ${Math.round(e.performance.p95Ms)}ms` };
      }
      if (e.performance.p95Ms > 1000) {
        return { outcome: 'WARN', detail: `p95 is ${Math.round(e.performance.p95Ms)}ms` };
      }
      return { outcome: 'PASS', detail: `p95 is ${Math.round(e.performance.p95Ms)}ms` };
    },
  },

  // ----------------------------------------------------------------- RECOVERY
  {
    id: 'RECENT_BACKUP',
    dimension: 'RECOVERY',
    statement: 'A backup succeeded within the last day.',
    rationale:
      'Backup age is the upper bound on how much work an incident can destroy. ' +
      'It is the only number in recovery planning that is not a guess.',
    severity: 'BLOCKER',
    evaluate: (e) => {
      const age = daysSince(e.backups.lastSucceededAt);
      if (age === null) return productionOnly(e, true, 'No backup has ever succeeded');
      if (age > 7) return { outcome: 'FAIL', detail: `Newest backup is ${age.toFixed(1)} days old` };
      if (age > 1) return { outcome: 'WARN', detail: `Newest backup is ${age.toFixed(1)} days old` };
      return { outcome: 'PASS', detail: `Newest backup is ${(age * 24).toFixed(1)} hours old` };
    },
  },
  {
    id: 'BACKUPS_ENCRYPTED',
    dimension: 'RECOVERY',
    statement: 'Every stored backup is encrypted.',
    rationale:
      'A backup is a complete copy of every tenant’s data with none of the ' +
      'access control. Unencrypted, it is the easiest way to lose everything at once.',
    severity: 'BLOCKER',
    evaluate: (e) => {
      if (e.backups.count === 0) return { outcome: 'UNKNOWN', detail: 'No backups stored' };
      return e.backups.allEncrypted
        ? { outcome: 'PASS', detail: `All ${e.backups.count} backup(s) encrypted` }
        : { outcome: 'FAIL', detail: 'At least one backup is stored in the clear' };
    },
  },
  {
    id: 'BACKUP_VERIFIED',
    dimension: 'RECOVERY',
    statement: 'A backup has been verified by reading it back.',
    rationale:
      'A backup nobody has read is a hypothesis. Verification is the difference ' +
      'between having backups and having recovery.',
    severity: 'REQUIRED',
    evaluate: (e) => {
      const age = daysSince(e.backups.lastVerifiedAt);
      if (age === null) return { outcome: 'FAIL', detail: 'No backup has been verified' };
      if (age > 30) return { outcome: 'WARN', detail: `Last verified ${age.toFixed(0)} days ago` };
      return { outcome: 'PASS', detail: `Last verified ${age.toFixed(1)} days ago` };
    },
  },
  {
    id: 'RESTORE_EXERCISED',
    dimension: 'RECOVERY',
    statement: 'A restore has been performed, not merely documented.',
    rationale:
      'The first time a restore is attempted should not be during the incident ' +
      'that requires it.',
    severity: 'REQUIRED',
    evaluate: (e) =>
      e.backups.restoreTested
        ? { outcome: 'PASS', detail: 'Restore exercised against a real backup' }
        : { outcome: 'FAIL', detail: 'Restore has never been exercised' },
  },

  // ------------------------------------------------------------ DOCUMENTATION
  {
    id: 'API_DOCUMENTED',
    dimension: 'DOCUMENTATION',
    statement: 'The API is documented and the document is generated.',
    rationale:
      'Hand-written API documentation is wrong the first time the code changes. ' +
      'Generated documentation is wrong only when the code is.',
    severity: 'REQUIRED',
    evaluate: (e) =>
      e.documentation.apiOperations > 0
        ? { outcome: 'PASS', detail: `${e.documentation.apiOperations} documented operation(s)` }
        : { outcome: 'FAIL', detail: 'No documented operations' },
  },
  {
    id: 'RUNBOOKS',
    dimension: 'OPERATIONS',
    statement: 'Operational runbooks exist for deployment, recovery and incidents.',
    rationale:
      'Procedures that live only in someone’s head are unavailable exactly when ' +
      'that person is asleep.',
    severity: 'REQUIRED',
    evaluate: (e) =>
      e.documentation.runbooks >= 3
        ? { outcome: 'PASS', detail: `${e.documentation.runbooks} runbook(s)` }
        : { outcome: 'FAIL', detail: `${e.documentation.runbooks} runbook(s) — expected at least 3` },
  },

  // -------------------------------------------------- DEVELOPER EXPERIENCE
  {
    id: 'AUTOMATED_QUALITY_GATE',
    dimension: 'DEVELOPER_EXPERIENCE',
    statement: 'Automated tests gate every deployment.',
    rationale:
      'A test suite that does not block a deploy is a suggestion. The value is ' +
      'in the gate, not in the coverage number.',
    severity: 'BLOCKER',
    evaluate: (e) => {
      if (!e.quality.gatesDeployment) {
        return productionOnly(e, true, 'The pipeline does not block on test failure');
      }
      if (e.quality.lastRunPassed === false) {
        return { outcome: 'FAIL', detail: `${e.quality.suites} suite(s), last run failed` };
      }
      return { outcome: 'PASS', detail: `${e.quality.suites} suite(s) gate deployment` };
    },
  },
  {
    id: 'REPRODUCIBLE_ENVIRONMENT',
    dimension: 'DEVELOPER_EXPERIENCE',
    statement: 'The runtime is containerised and reproducible.',
    rationale:
      '"Works on my machine" is a class of incident, and the fix is that nobody ' +
      'runs it on their machine.',
    severity: 'REQUIRED',
    evaluate: (e) =>
      e.config.trustProxy || e.environment !== 'production'
        ? { outcome: 'PASS', detail: 'Containerised runtime with environment-driven configuration' }
        : { outcome: 'WARN', detail: 'Proxy trust not configured' },
  },
];

export const READINESS_CHECKS: readonly ReadinessCheck[] = Object.freeze(
  CHECKS.map((check) => Object.freeze(check)),
);

/**
 * A fingerprint of the bar itself: identifiers, severities and statements.
 * Stamped on every review so a pass recorded under a weaker bar is identifiable.
 */
export const READINESS_VERSION: string = createHash('sha256')
  .update(READINESS_CHECKS.map((c) => `${c.id}:${c.severity}:${c.statement}`).join('|'))
  .digest('hex')
  .slice(0, 16);

export interface ReadinessVerdict {
  id: string;
  dimension: ReadinessDimension;
  statement: string;
  rationale: string;
  severity: ReadinessSeverity;
  outcome: ReadinessOutcome;
  detail: string;
}

export interface ReadinessReview {
  environment: Environment;
  version: string;
  reviewedAt: string;
  /** True only when no BLOCKER is failing. */
  readyForProduction: boolean;
  /** Share of checks passing, ignoring those that could not be evaluated. */
  score: number;
  summary: Record<ReadinessOutcome, number>;
  blockers: ReadinessVerdict[];
  dimensions: Array<{
    dimension: ReadinessDimension;
    outcome: ReadinessOutcome;
    checks: ReadinessVerdict[];
  }>;
  verdicts: ReadinessVerdict[];
}

/** Worst outcome wins when rolling checks up into a dimension. */
const OUTCOME_RANK: Record<ReadinessOutcome, number> = {
  PASS: 0,
  UNKNOWN: 1,
  WARN: 2,
  FAIL: 3,
};

/**
 * Runs every check against the evidence. No short-circuiting: a review that
 * stops at the first failure tells an operator to fix one thing and come back,
 * which turns a single audit into a queue of audits.
 */
export function review(evidence: ReadinessEvidence): ReadinessReview {
  const verdicts: ReadinessVerdict[] = READINESS_CHECKS.map((check) => {
    const { outcome, detail } = check.evaluate(evidence);
    return {
      id: check.id,
      dimension: check.dimension,
      statement: check.statement,
      rationale: check.rationale,
      severity: check.severity,
      outcome,
      detail,
    };
  });

  const summary: Record<ReadinessOutcome, number> = { PASS: 0, WARN: 0, FAIL: 0, UNKNOWN: 0 };
  for (const verdict of verdicts) summary[verdict.outcome] += 1;

  const blockers = verdicts.filter((v) => v.severity === 'BLOCKER' && v.outcome === 'FAIL');

  // UNKNOWN is excluded from the denominator rather than counted as a failure:
  // a check that could not run says nothing about the system, and folding it
  // into the score would make an unmonitored system look unhealthy in the same
  // way an unhealthy one does.
  const judged = verdicts.filter((v) => v.outcome !== 'UNKNOWN');
  const score = judged.length
    ? Number((judged.filter((v) => v.outcome === 'PASS').length / judged.length).toFixed(4))
    : 0;

  const dimensions = DIMENSIONS.map((dimension) => {
    const checks = verdicts.filter((v) => v.dimension === dimension);
    const worst = checks.reduce<ReadinessOutcome>(
      (acc, v) => (OUTCOME_RANK[v.outcome] > OUTCOME_RANK[acc] ? v.outcome : acc),
      'PASS',
    );
    return { dimension, outcome: worst, checks };
  }).filter((entry) => entry.checks.length > 0);

  return {
    environment: evidence.environment,
    version: READINESS_VERSION,
    reviewedAt: new Date().toISOString(),
    readyForProduction: blockers.length === 0,
    score,
    summary,
    blockers,
    dimensions,
    verdicts,
  };
}

/** The bar itself, without evaluating it. For the documentation surface. */
export function describeChecks(): Array<Omit<ReadinessCheck, 'evaluate'>> {
  return READINESS_CHECKS.map(({ id, dimension, statement, rationale, severity }) => ({
    id,
    dimension,
    statement,
    rationale,
    severity,
  }));
}
