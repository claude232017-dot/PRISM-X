-- Phase Omega — composite tenant/time indexes on the append-only tables.
--
-- Every one of these tables is read the same way: "the most recent N rows for
-- this organization". Until now that was served by an index on
-- `organizationId` alone, which means Postgres fetched every row the tenant has
-- ever written and then sorted them to find the newest twenty. That is fine at
-- ten thousand rows and a full outage at ten million, and it degrades on the
-- exact tables that grow fastest.
--
-- The composite indexes are declared DESC to match the ORDER BY at the call
-- sites, so the index supplies the ordering and the sort disappears from the
-- plan entirely.
--
-- The bare `createdAt` / `startedAt` indexes serve the retention sweep, which
-- deletes by age across all tenants and would otherwise sequentially scan.
--
-- OPERATIONAL NOTE: these are written IF NOT EXISTS on purpose. `CREATE INDEX`
-- takes a lock that blocks writes for the duration of the build, and on a table
-- with tens of millions of rows that is a write outage. On a live database with
-- meaningful volume, run the CONCURRENTLY forms in
-- `docs/runbooks/scaling.md` BEFORE deploying this migration; the statements
-- below then find the indexes already present and cost nothing.

-- events
CREATE INDEX IF NOT EXISTS "events_organizationId_createdAt_idx"
  ON "events" ("organizationId", "createdAt" DESC);

-- audit_logs
CREATE INDEX IF NOT EXISTS "audit_logs_organizationId_createdAt_idx"
  ON "audit_logs" ("organizationId", "createdAt" DESC);

-- tool_calls
CREATE INDEX IF NOT EXISTS "tool_calls_organizationId_createdAt_idx"
  ON "tool_calls" ("organizationId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "tool_calls_createdAt_idx"
  ON "tool_calls" ("createdAt");

-- execution_logs
-- The existing (organizationId, startedAt) index is replaced rather than
-- supplemented. A DESC index answers ASC queries by scanning backwards, so
-- keeping both would buy nothing and cost a second write on every execution.
DROP INDEX IF EXISTS "execution_logs_organizationId_startedAt_idx";
CREATE INDEX IF NOT EXISTS "execution_logs_organizationId_startedAt_idx"
  ON "execution_logs" ("organizationId", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "execution_logs_startedAt_idx"
  ON "execution_logs" ("startedAt");

-- notifications
CREATE INDEX IF NOT EXISTS "notifications_organizationId_createdAt_idx"
  ON "notifications" ("organizationId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "notifications_createdAt_idx"
  ON "notifications" ("createdAt");

-- extension_host_calls
CREATE INDEX IF NOT EXISTS "extension_host_calls_organizationId_createdAt_idx"
  ON "extension_host_calls" ("organizationId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "extension_host_calls_createdAt_idx"
  ON "extension_host_calls" ("createdAt");
