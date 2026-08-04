-- ============================================================
-- PRISM-X — RLS for the Phase 8 production tables
--
-- Phase 8 introduces a third policy shape, alongside the two Phase 7 needed.
--
--   Tenant tables — subscriptions, invoices, sessions, allowlists, compliance
--   reports. The contract every phase before this used: no organization
--   context means no rows, and WITH CHECK stops a constrained session writing
--   rows it does not own.
--
--   Catalogue — `plans`. Readable by everyone, writable by no constrained
--   client. A customer has to be able to see what they can buy, and nobody
--   buying gets to edit the price.
--
--   Operator tables — instances, backups, restore runs, alert rules and
--   events, secret rotations, releases, readiness reviews. RLS is enabled and
--   *no policy is created*. In Postgres that denies every row to every role
--   the policies would otherwise govern, which is exactly right: these
--   describe the platform, not a tenant, and they carry backup locations,
--   checksums, key identifiers and infrastructure health. The backend's own
--   trusted connection is the only way in, and that is a deliberate choice
--   rather than an omission — the absence of a policy here is the policy.
--
-- `mfa_enrollments` is deliberately absent from all three lists: it is keyed
-- on a user, who is global, and it holds a sealed secret that no tenant
-- session should reach. It gets the operator treatment.
-- ============================================================

-- ------------------------------------------------------------
-- Tenant-private tables
-- ------------------------------------------------------------
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'subscriptions', 'invoices', 'user_sessions',
    'ip_allow_entries', 'compliance_reports'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tenant_table);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING ("organizationId" = app_current_organization_id())
        WITH CHECK ("organizationId" = app_current_organization_id())
    $p$, tenant_table);
  END LOOP;
END
$$;

-- ------------------------------------------------------------
-- Public catalogue: anyone may read a plan, nobody constrained may write one
-- ------------------------------------------------------------
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalogue_read ON plans;
CREATE POLICY catalogue_read ON plans FOR SELECT USING (true);

-- ------------------------------------------------------------
-- Operator tables: RLS on, no policies, therefore no rows for anyone
-- constrained. Reachable only through the backend's trusted connection.
-- ------------------------------------------------------------
DO $$
DECLARE
  operator_table text;
BEGIN
  FOREACH operator_table IN ARRAY ARRAY[
    'instances', 'backups', 'restore_runs', 'alert_rules', 'alert_events',
    'secret_rotations', 'releases', 'readiness_reviews', 'mfa_enrollments'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', operator_table);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prismx_tenant;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prismx_tenant;
