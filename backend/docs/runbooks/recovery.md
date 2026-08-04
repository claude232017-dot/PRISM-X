# Runbook — Backup and recovery

## The number that matters

Backup age is the upper bound on how much work an incident can destroy. It is
the only figure in recovery planning that is not a guess.

```bash
curl -fsS "$API/ops/backups/posture" -H "authorization: Bearer $TOKEN"
# → { "ageHours": 0.4, "allEncrypted": true, "restoreExercised": true, ... }
```

## Taking a backup

```bash
curl -X POST "$API/ops/backups" -H "authorization: Bearer $TOKEN" \
  -d '{"kind":"DATABASE","retentionDays":30}'
```

Each backup is encrypted with a fresh data key, sealed with the platform key.
One compromised archive does not read the others, and rotating the platform key
re-seals rather than re-encrypts.

The checksum is taken over the **plaintext**, before compression and encryption.
Verifying therefore decrypts, decompresses and re-hashes — it exercises the
whole restore path rather than proving the file arrived intact.

## Verifying

```bash
curl -X POST "$API/ops/backups/$ID/verify" -H "authorization: Bearer $TOKEN"
# → { "ok": true, "detail": "Checksum matched; 28 table(s) readable" }
```

A backup that fails verification is marked `CORRUPT`, not `FAILED`. That is
deliberate and it is loud: a corrupt backup is worse than a missing one, because
it is the one somebody would have relied on.

**Verify monthly.** A backup nobody has read is a hypothesis.

## Restoring

`dryRun` defaults to `true`. That default is the design: a restore overwrites
live data with older data at the exact moment nobody is thinking clearly, so an
accidental call validates and a real one requires saying so.

```bash
# Validate first. Always.
curl -X POST "$API/ops/backups/$ID/restore" -H "authorization: Bearer $TOKEN" \
  -d '{"mode":"FULL","dryRun":true}'

# Then, having read the row counts:
curl -X POST "$API/ops/backups/$ID/restore" -H "authorization: Bearer $TOKEN" \
  -d '{"mode":"FULL","dryRun":false}'
```

Rows are inserted with `ON CONFLICT DO NOTHING`, in declared dependency order.
Conflicts are skipped rather than overwritten: a restore that clobbers rows
newer than the backup turns a partial loss into a total one.

## Point in time

```bash
curl -X POST "$API/ops/backups/point-in-time" -H "authorization: Bearer $TOKEN" \
  -d '{"targetTime":"2026-08-01T00:00:00Z","dryRun":true}'
```

This reconstructs to **the nearest backup at or before the target**, filtered by
row creation time. It is not second-accurate recovery. True point-in-time
recovery needs WAL archiving at the database — `archive_mode=on` with a
`restore_command`, which is a Postgres configuration rather than an application
feature. The response says so rather than implying otherwise.

## Recovery drill

Quarterly, and recorded:

1. Take a backup.
2. Verify it.
3. Restore it into a scratch database with `dryRun: false`.
4. Confirm row counts against the manifest.
5. `GET /ops/backups/restores` should now show a non-dry-run success — which is
   what makes the `RESTORE_EXERCISED` readiness check pass.

The first time a restore is attempted should not be during the incident that
requires it.
