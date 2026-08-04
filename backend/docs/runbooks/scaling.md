# Runbook — Scaling

## Adding instances

```bash
docker compose -f docker-compose.prod.yml up -d --scale api=5 api
```

Nothing else. No configuration changes anywhere, because:

- **Sessions** are rows in Postgres, resolved per request.
- **Cache and rate-limit counters** are in Redis, shared.
- **Queues** are BullMQ on shared Redis; a job is claimed, not routed.
- **Request context** is per-request `AsyncLocalStorage`, discarded on response.
- **Scheduled work** runs only for the lease holder.

The last one is the load-bearing item. Without it, five instances fire every
schedule five times — and nothing errors, the work simply happens repeatedly,
which is the hardest kind of failure to see from outside.

Verify after scaling:

```bash
curl -fsS "$API/ops/instances" -H "authorization: Bearer $TOKEN"
# healthy: 5, and exactly one entry with "isLeader": true
```

## Removing instances

`docker compose ... --scale api=2`. Each stopping instance releases the lease
and marks itself stopped in its shutdown hook, so the fleet view is accurate
within a heartbeat rather than after a timeout.

## Sizing the connection pool

Each instance opens its own pool, so the fleet's total connection demand is
`DATABASE_CONNECTION_LIMIT × replicas` plus one for the migrate job. Postgres
ships with `max_connections = 100`; managed poolers are often lower.

Set the limit from the ceiling, not from the instance:

```
DATABASE_CONNECTION_LIMIT = (pooler capacity − 10 headroom) / replicas
```

Never raise `replicas` without recomputing this. The failure mode is not
gradual — the pool is fine until it is exhausted, and then every instance
starts refusing connections simultaneously, including for the readiness probe,
which takes the whole fleet out of the balancer at once.

`DATABASE_POOL_TIMEOUT` (seconds) bounds how long a query waits for a free
connection. Leave it set. An unbounded wait converts pool pressure into hung
requests that hold their own resources, which is how one slow query becomes an
outage.

Both are reported by `/ops/health/deep` under `database.pool`, so you can
confirm what an instance is actually running with rather than what you meant
to deploy.

## Creating the hot-path indexes without a write outage

`CREATE INDEX` holds a lock that blocks writes until the build finishes. On the
append-only tables (`events`, `audit_logs`, `tool_calls`, `execution_logs`)
that build can take minutes, and every write blocks for the duration.

Migration `20260804150000_omega_hot_path_indexes` is written `IF NOT EXISTS`
so you can build the indexes ahead of the deploy, without a lock, and let the
migration find them already present:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_organizationId_createdAt_idx"
  ON "events" ("organizationId", "createdAt" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_organizationId_createdAt_idx"
  ON "audit_logs" ("organizationId", "createdAt" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tool_calls_organizationId_createdAt_idx"
  ON "tool_calls" ("organizationId", "createdAt" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tool_calls_createdAt_idx"
  ON "tool_calls" ("createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "execution_logs_startedAt_idx"
  ON "execution_logs" ("startedAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_organizationId_createdAt_idx"
  ON "notifications" ("organizationId", "createdAt" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_createdAt_idx"
  ON "notifications" ("createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "extension_host_calls_organizationId_createdAt_idx"
  ON "extension_host_calls" ("organizationId", "createdAt" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "extension_host_calls_createdAt_idx"
  ON "extension_host_calls" ("createdAt");
```

Run each statement outside a transaction, one at a time. `CONCURRENTLY` can
leave an index `INVALID` if it fails — check with
`SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;` and drop and
rebuild any it lists before deploying.

The `execution_logs` composite is a rewrite rather than an addition: the
migration drops `(organizationId, startedAt)` ASC and rebuilds it DESC. To do
that without a lock, build it under a temporary name concurrently, then drop
and rename inside a single short transaction.

## What does not scale by adding instances

- **Database connections.** Each instance opens a pool. Past roughly ten
  instances, put PgBouncer in front rather than raising Postgres's limit.
- **Provider rate limits.** These are per account, not per instance. More
  instances means more concurrent calls into the same ceiling.
- **A single long mission.** Missions parallelise across *tasks*; one task runs
  on one worker on one node.

## Capacity signals

| Metric | Meaning | Action |
|---|---|---|
| `prismx_http_request_duration_ms` p95 rising, CPU flat | Waiting on something | Look at the database and providers before adding instances |
| CPU high across every instance | Genuinely CPU bound | Add instances |
| `prismx_queue_depth` climbing | Producing faster than consuming | Add instances, or nodes for execution |
| `prismx_instances_healthy` below replicas | Instances failing readiness | Check `/ops/health/ready` on each |

Adding instances helps only the third row. The first two need a cause, and
adding capacity to a system waiting on a lock makes the lock contention worse.
