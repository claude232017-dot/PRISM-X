/**
 * Data retention policy.
 *
 * Every table listed here is append-only and grows with traffic rather than
 * with the size of the business. An organization running a thousand missions a
 * day writes events, tool calls and execution logs forever, and "forever" is
 * not a storage problem first — it is a *query* problem. The indexes stop
 * fitting in memory, the planner's estimates drift, autovacuum falls behind on
 * a table it can never finish, and the symptom that reaches a human is that
 * listing recent activity got slow. By then the table is too large to fix
 * during business hours.
 *
 * So retention is declared, not improvised. Each window is a default that an
 * operator can raise or lower per deployment through the environment, and each
 * one carries the reason it is what it is — because the next person to change
 * `AUDIT_LOG_RETENTION_DAYS` should have to think about why it was 365.
 *
 * Two rules constrain this list:
 *
 * **Nothing here is a source of truth.** Missions, workers, knowledge and
 * credentials are never pruned. Only derived records — the trail of what
 * happened, not the thing that happened — are eligible, so a deletion can cost
 * you forensics but never state.
 *
 * **Zero means keep forever.** A deployment under a legal hold sets the window
 * to 0 and the sweep skips the table entirely. That has to be expressible, and
 * it has to be expressible without commenting out code.
 */

export interface RetentionRule {
  /** Physical table name. */
  readonly table: string;
  /** Timestamp column the age is measured from. */
  readonly column: string;
  /** Default window in days. 0 disables pruning for the table. */
  readonly defaultDays: number;
  /** Environment variable that overrides the default. */
  readonly env: string;
  /** Why this window, in one line. */
  readonly rationale: string;
}

export const RETENTION_VERSION = '1.0.0';

export const RETENTION_RULES: readonly RetentionRule[] = Object.freeze([
  {
    table: 'events',
    column: 'createdAt',
    defaultDays: 90,
    env: 'EVENT_RETENTION_DAYS',
    rationale:
      'The event log is a fan-out mechanism first and a history second. A quarter ' +
      'covers incident forensics; anything older is answered by the domain tables.',
  },
  {
    table: 'audit_logs',
    column: 'createdAt',
    defaultDays: 365,
    env: 'AUDIT_LOG_RETENTION_DAYS',
    rationale:
      'A year is the shortest window most compliance regimes accept. Longer than ' +
      'the other tables on purpose: this is the one an auditor asks for.',
  },
  {
    table: 'execution_logs',
    column: 'startedAt',
    defaultDays: 90,
    env: 'EXECUTION_LOG_RETENTION_DAYS',
    rationale:
      'Cost and latency analysis works on recent data; the aggregates it feeds ' +
      'are already rolled up into usage_daily, which is not pruned.',
  },
  {
    table: 'tool_calls',
    column: 'createdAt',
    defaultDays: 90,
    env: 'TOOL_CALL_RETENTION_DAYS',
    rationale: 'Matches execution_logs — a tool call without its execution is not useful.',
  },
  {
    table: 'extension_host_calls',
    column: 'createdAt',
    defaultDays: 30,
    env: 'EXTENSION_HOST_CALL_RETENTION_DAYS',
    rationale:
      'The highest-volume table in the system: one row per SDK method an extension ' +
      'invokes. Kept long enough to investigate a misbehaving extension, no longer.',
  },
  {
    table: 'extension_lifecycle_events',
    column: 'createdAt',
    defaultDays: 180,
    env: 'EXTENSION_LIFECYCLE_RETENTION_DAYS',
    rationale:
      'Install and upgrade history explains how an extension reached its current ' +
      'state, which is a question asked months later.',
  },
  {
    table: 'notifications',
    column: 'createdAt',
    defaultDays: 90,
    env: 'NOTIFICATION_RETENTION_DAYS',
    rationale: 'Nobody reads a quarter-old notification; the underlying record persists.',
  },
  {
    table: 'webhook_deliveries',
    column: 'createdAt',
    defaultDays: 30,
    env: 'WEBHOOK_DELIVERY_RETENTION_DAYS',
    rationale:
      'Delivery attempts are operational noise once the endpoint is healthy. ' +
      'Unresolved failures surface through dead letters, which are not pruned.',
  },
  {
    table: 'memory_sync_ops',
    column: 'createdAt',
    defaultDays: 30,
    env: 'MEMORY_SYNC_RETENTION_DAYS',
    rationale:
      'A replication journal. Once every node is past a sequence, the entries ' +
      'below it cannot be requested again.',
  },
  {
    table: 'alert_events',
    column: 'firedAt',
    defaultDays: 180,
    env: 'ALERT_EVENT_RETENTION_DAYS',
    rationale:
      'Half a year of alert history is enough to argue about a threshold; firing ' +
      'alerts are excluded from the sweep by the resolved-only predicate.',
  },
  {
    table: 'user_sessions',
    column: 'expiresAt',
    defaultDays: 7,
    env: 'SESSION_RETENTION_DAYS',
    rationale:
      'Measured from expiry rather than creation. A week past expiry leaves a ' +
      'trail for "who was logged in when" without keeping dead sessions forever.',
  },
]);

/** Rows deleted per statement. Small enough that the lock is never noticed. */
export const PRUNE_BATCH = 1_000;

/**
 * Batches per table per sweep.
 *
 * A cap rather than "delete everything eligible" because the first sweep after
 * enabling retention on an old database would otherwise try to delete tens of
 * millions of rows in one transaction, which is how a maintenance task becomes
 * an outage. Capped, the backlog drains over several hours and the steady state
 * is reached without anybody noticing.
 */
export const PRUNE_MAX_BATCHES = 50;

/** Predicates that protect rows the age test alone would take. */
export const PRUNE_GUARDS: Readonly<Record<string, string>> = Object.freeze({
  // Never prune an alert that is still firing, however old it is.
  alert_events: `"resolvedAt" IS NOT NULL`,
  // A delivery still being retried is live work, not history.
  webhook_deliveries: `"status" <> 'PENDING'`,
});

/** Resolves the configured window for a rule. Invalid values fall back. */
export function windowDays(
  rule: RetentionRule,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[rule.env];
  if (raw === undefined || raw === '') return rule.defaultDays;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return rule.defaultDays;
  return parsed;
}

/** The cutoff instant for a rule, or null when retention is disabled. */
export function cutoffFor(
  rule: RetentionRule,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Date | null {
  const days = windowDays(rule, env);
  if (days <= 0) return null;
  return new Date(now.getTime() - days * 86_400_000);
}

/** The policy as data, for the operations endpoint and the runbook. */
export function describePolicy(env: NodeJS.ProcessEnv = process.env): Array<
  Record<string, unknown>
> {
  return RETENTION_RULES.map((rule) => {
    const days = windowDays(rule, env);
    return {
      table: rule.table,
      column: rule.column,
      days,
      enabled: days > 0,
      overriddenBy: rule.env,
      isDefault: days === rule.defaultDays,
      guard: PRUNE_GUARDS[rule.table] ?? null,
      rationale: rule.rationale,
    };
  });
}
