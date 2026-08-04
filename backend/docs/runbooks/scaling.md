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
