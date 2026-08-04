# Runbook — Deployment

## What a deploy is

Three steps, in this order, and the order is the whole procedure:

1. **Migrate.** One process, run to completion, before any new instance starts.
2. **Roll out.** New instances start, pass readiness, and take traffic; old
   instances drain and exit.
3. **Verify.** Health, then the readiness review, then the error rate.

Migration is separate from startup on purpose. If every instance ran
`migrate deploy` at boot, N instances would race to apply the same migration,
and a failure would leave part of the fleet on a schema the code cannot use.

## Preconditions

- The pipeline is green on the commit being deployed.
- `prisma migrate deploy` applies cleanly to an empty database in CI. This is
  the check that catches a migration named before the one that creates its
  tables — it passes against a database that already has them.
- A backup succeeded within the last hour: `GET /api/v1/ops/backups/posture`.
- No CRITICAL alert is firing: `GET /api/v1/ops/alerts`.

## Procedure

```bash
# 1. Record the release before touching anything. A deploy that fails halfway
#    should still be in the history.
curl -X POST "$API/admin/releases" -H "authorization: Bearer $TOKEN" \
  -d '{"environment":"PRODUCTION","version":"1.4.2","commitSha":"a91f3c2"}'
# → { "id": "clx0rel1", ... }

# 2. Migrate. Once.
docker compose -f docker-compose.prod.yml run --rm migrate

# 3. Roll out.
docker compose -f docker-compose.prod.yml up -d --no-deps --scale api=3 api

# 4. Verify.
curl -fsS "$API/ops/health/ready"
curl -fsS "$API/ops/readiness" -H "authorization: Bearer $TOKEN"

# 5. Close the record.
curl -X POST "$API/admin/releases/clx0rel1/complete" \
  -H "authorization: Bearer $TOKEN" -d '{"succeeded":true}'
```

## Rolling restart behaviour

Each instance releases the scheduler lease in its shutdown hook rather than
letting it expire, so schedules move to another instance in seconds rather than
after a full lease window. `stop_grace_period` is 30s, which is long enough for
in-flight requests to finish; nginx retries the next instance on 502/503/504, so
a restarting instance is invisible to callers.

## Rolling back

```bash
curl -X POST "$API/admin/releases/clx0rel1/rollback" \
  -H "authorization: Bearer $TOKEN" -d '{"reason":"Error rate spiked after deploy"}'
```

The rollback is recorded as a *new* release pointing at what it undid. The
original is not rewritten: production did run that version, and erasing that
loses the fact.

**Migrations are not rolled back.** Schema changes must be backward compatible
with the previous release, which means: add columns, never rename or drop in the
same release that stops using them. Dropping is a later release, after nothing
reads the column.
