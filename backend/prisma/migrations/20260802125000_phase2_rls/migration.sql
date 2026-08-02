-- ============================================================
-- PRISM-X — RLS for the Phase 2 tables
--
-- Same contract as the Phase 1 policies: a session with no
-- `app.current_organization_id` sees nothing, and WITH CHECK stops a
-- constrained session writing rows it does not own. Memory and execution
-- telemetry are among the most sensitive data in the system — a worker's
-- long-term memory and its prompts must never cross a tenant boundary.
-- ============================================================

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'memories', 'execution_logs', 'tool_calls', 'usage_daily'
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

-- The least-privilege role predates these tables, so its grants do not
-- cover them yet.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prismx_tenant;
