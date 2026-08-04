# Runbook — Incident response

## First five minutes

```bash
curl -fsS "$API/ops/health/deep"                                  # is anything up
curl -fsS "$API/ops/alerts"      -H "authorization: Bearer $TOKEN" # what fired
curl -fsS "$API/ops/instances"   -H "authorization: Bearer $TOKEN" # who is serving
curl -fsS "$API/ops/metrics/json" -H "authorization: Bearer $TOKEN" | head -c 2000
```

Every response carries `x-request-id` and `x-instance-id`. A caller reporting a
problem should quote the request id: across several instances it is the only
string that turns interleaved logs back into one story.

## Symptom → first check

| Symptom | Look at | Likely cause |
|---|---|---|
| 503 from the balancer | `/ops/health/ready` on each instance | Database unreachable; instances correctly refusing traffic |
| Rising p95, no errors | `/ops/metrics/json` → `prismx_http_request_duration_ms` | Database contention, or a provider stalling |
| 429s | `prismx_rate_limited_total` | A caller over budget, or Redis down so limiting degraded |
| Schedules not firing | `/ops/instances` → `leader` | No instance holds the lease; check database reachability |
| Schedules firing repeatedly | `/ops/instances` | Two leaders would mean the lease query is not doing its job — escalate |
| Dead letters climbing | `prismx_dead_letters` | Downstream integration failing; check `/automation/reliability` |
| Extension misbehaving | `/platform/extensions/:id/calls` | Denials show what it is reaching for |

## Losing the leader

Expected and self-healing. The lease expires after 45 seconds and another
instance claims it on its next heartbeat. Scheduled work pauses for at most one
lease window; nothing is lost, because a schedule that did not fire is retried
on the next tick.

Escalate only if `leader` stays null for more than two minutes — that means no
instance can write to the database, which is a different incident.

## Losing Redis

The platform degrades rather than stopping:

- Cache reads miss and fall through to the database. Slower, correct.
- Rate limiting falls back to per-process counters. Still limited, but N
  instances enforce N budgets — deliberate, and logged once.
- Queues stop accepting work. Missions already running finish.

Readiness deliberately does **not** fail on cache loss. Taking every instance
out of rotation because a cache is down converts a degraded dependency into an
outage.

## A compromised credential

```bash
# End every session for the user.
curl -X POST "$API/security/sessions/revoke-all" -H "authorization: Bearer $TOKEN"

# Rotate what the credential could reach.
curl -X POST "$API/security/rotate" -H "authorization: Bearer $TOKEN" \
  -d '{"scope":"CREDENTIAL_KEY","overlapHours":1}'

# What did it touch.
curl -X POST "$API/admin/compliance" -H "authorization: Bearer $TOKEN" \
  -d '{"kind":"AUDIT_SUMMARY"}'
```

Rotation keeps old material verifying for the overlap window. Set it short
during an incident — an hour, not a day — and to zero only if you are certain
nothing legitimate still holds the old key.

## A malicious extension

```bash
curl -fsS "$API/platform/extensions/$ID/calls" -H "authorization: Bearer $TOKEN"
curl -X POST "$API/platform/extensions/$ID/disable" -H "authorization: Bearer $TOKEN"
```

If it came from the marketplace and affects other tenants, publish an advisory
instead — that quarantines every affected install across every organization,
rather than only this one.
