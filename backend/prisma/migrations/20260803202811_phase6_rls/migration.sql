-- ============================================================
-- PRISM-X — RLS for the Phase 6 evolution tables
--
-- Same contract as Phases 1-5: no organization context means no rows, and
-- WITH CHECK stops a constrained session writing rows it does not own.
--
-- These tables carry the record of how each organization's system has been
-- allowed to change: its policy, its refused deployments, the exact state
-- captured before every production write. A cross-tenant read here would
-- disclose not just data but the shape of another organization's controls.
-- ============================================================

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'evolution_candidates', 'evolution_experiments', 'benchmarks',
    'entity_versions', 'deployments', 'evolution_policies',
    'constitution_violations', 'planning_strategies'
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
