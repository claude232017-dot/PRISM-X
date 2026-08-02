-- ============================================================
-- PRISM-X — RLS for the Phase 3 automation tables
--
-- Same contract as Phases 1-2: no organization context means no rows, and
-- WITH CHECK stops a constrained session writing rows it does not own.
--
-- These tables matter especially: API keys, webhook signing secrets and
-- workflow run context are exactly the data a cross-tenant read would be most
-- damaging on.
-- ============================================================

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'workflows', 'workflow_versions', 'workflow_runs', 'workflow_step_runs',
    'triggers', 'approval_requests', 'notifications', 'api_keys',
    'webhook_endpoints', 'webhook_deliveries', 'dead_letters'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prismx_tenant;
