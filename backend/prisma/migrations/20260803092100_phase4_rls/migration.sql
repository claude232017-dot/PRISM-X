-- ============================================================
-- PRISM-X — RLS for the Phase 4 distributed tables
--
-- Same contract as Phases 1-3: no organization context means no rows, and
-- WITH CHECK stops a constrained session writing rows it does not own.
--
-- Federation is the one place where a row is legitimately visible to two
-- organizations, so `federation_grants` gets its own policy below rather
-- than the standard single-column one.
-- ============================================================

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'nodes', 'node_capabilities', 'node_heartbeats', 'node_keys',
    'distributed_tasks', 'memory_shards', 'memory_sync_ops', 'node_sync_states'
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

-- A grant is readable by both parties — the peer has to be able to see what
-- it was given — but only the issuing organization may create, amend or
-- revoke one. That asymmetry is the whole point: access is something you are
-- given, never something you can award yourself.
ALTER TABLE federation_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON federation_grants;
CREATE POLICY tenant_isolation ON federation_grants
  USING (
    "organizationId" = app_current_organization_id()
    OR "peerOrganizationId" = app_current_organization_id()
  )
  WITH CHECK ("organizationId" = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prismx_tenant;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prismx_tenant;
