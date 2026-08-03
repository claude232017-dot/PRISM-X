-- ============================================================
-- PRISM-X — RLS for the Phase 5 learning tables
--
-- Same contract as Phases 1-4: no organization context means no rows, and
-- WITH CHECK stops a constrained session writing rows it does not own.
--
-- These tables are worth the care. A mission review names what went wrong
-- and what it cost; a worker profile records where an agent is weak; a
-- recommendation carries a proposed production change and the state to roll
-- back to. Cross-tenant read of any of them would be a disclosure of how
-- another organization operates, not merely of its data.
-- ============================================================

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'mission_reviews', 'performance_snapshots', 'recommendations',
    'worker_profiles', 'detected_patterns', 'learning_entries',
    'knowledge_audits', 'experiments'
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
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prismx_tenant;
