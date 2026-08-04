-- ============================================================
-- PRISM-X — RLS for the Phase 7 platform tables
--
-- Phase 7 is the first phase whose data is not entirely tenant-private, so it
-- needs two policy shapes rather than one.
--
--   Tenant tables — the usual contract, identical to Phases 1-6: no
--   organization context means no rows, and WITH CHECK stops a constrained
--   session writing rows it does not own. These hold what an organization
--   installed, what it configured, what its extensions did and what its
--   developers built, all of which is nobody else's business.
--
--   Catalogue tables — publishers, listings, versions and advisories are read
--   by everyone by design: a marketplace partitioned by tenant is not a
--   marketplace. They are therefore readable by all and writable only by the
--   organization that owns the row, which is expressed as separate SELECT and
--   INSERT/UPDATE/DELETE policies rather than one combined policy. A single
--   `USING` clause cannot say "everyone may read, only the owner may write" —
--   it would hide other publishers' rows from the catalogue entirely.
--
-- Ownership for versions is derived from the parent listing rather than
-- duplicated onto the row, so a listing that changes hands cannot leave
-- versions behind that the previous owner can still rewrite.
-- ============================================================

-- ------------------------------------------------------------
-- Tenant-private tables
-- ------------------------------------------------------------
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'extension_lifecycle_events', 'extension_contributions', 'extension_state',
    'extension_host_calls', 'extension_upgrades', 'marketplace_reviews',
    'developer_apps', 'developer_api_usage'
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
-- Catalogue tables owning their organization directly
-- ------------------------------------------------------------
DO $$
DECLARE
  catalogue_table text;
  owner_column text;
BEGIN
  FOREACH catalogue_table IN ARRAY ARRAY['publishers', 'marketplace_listings', 'security_advisories']
  LOOP
    owner_column := CASE catalogue_table
      WHEN 'security_advisories' THEN 'raisedByOrgId'
      ELSE 'ownerOrganizationId'
    END;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', catalogue_table);

    EXECUTE format('DROP POLICY IF EXISTS catalogue_read ON %I', catalogue_table);
    EXECUTE format('CREATE POLICY catalogue_read ON %I FOR SELECT USING (true)', catalogue_table);

    EXECUTE format('DROP POLICY IF EXISTS catalogue_insert ON %I', catalogue_table);
    EXECUTE format(
      'CREATE POLICY catalogue_insert ON %I FOR INSERT WITH CHECK (%I = app_current_organization_id())',
      catalogue_table, owner_column
    );

    EXECUTE format('DROP POLICY IF EXISTS catalogue_update ON %I', catalogue_table);
    EXECUTE format(
      'CREATE POLICY catalogue_update ON %I FOR UPDATE USING (%I = app_current_organization_id()) WITH CHECK (%I = app_current_organization_id())',
      catalogue_table, owner_column, owner_column
    );

    EXECUTE format('DROP POLICY IF EXISTS catalogue_delete ON %I', catalogue_table);
    EXECUTE format(
      'CREATE POLICY catalogue_delete ON %I FOR DELETE USING (%I = app_current_organization_id())',
      catalogue_table, owner_column
    );
  END LOOP;
END
$$;

-- ------------------------------------------------------------
-- Listing versions — ownership derived from the parent listing
-- ------------------------------------------------------------
ALTER TABLE marketplace_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS catalogue_read ON marketplace_versions;
CREATE POLICY catalogue_read ON marketplace_versions FOR SELECT USING (true);

DROP POLICY IF EXISTS catalogue_insert ON marketplace_versions;
CREATE POLICY catalogue_insert ON marketplace_versions FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM marketplace_listings l
    WHERE l.id = marketplace_versions."listingId"
      AND l."ownerOrganizationId" = app_current_organization_id()
  ));

DROP POLICY IF EXISTS catalogue_update ON marketplace_versions;
CREATE POLICY catalogue_update ON marketplace_versions FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM marketplace_listings l
    WHERE l.id = marketplace_versions."listingId"
      AND l."ownerOrganizationId" = app_current_organization_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM marketplace_listings l
    WHERE l.id = marketplace_versions."listingId"
      AND l."ownerOrganizationId" = app_current_organization_id()
  ));

DROP POLICY IF EXISTS catalogue_delete ON marketplace_versions;
CREATE POLICY catalogue_delete ON marketplace_versions FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM marketplace_listings l
    WHERE l.id = marketplace_versions."listingId"
      AND l."ownerOrganizationId" = app_current_organization_id()
  ));

-- ------------------------------------------------------------
-- Governance reviews — readable by all, writable by no constrained client.
--
-- A moderation decision is not the publisher's to write, and the publisher is
-- the only organization a constrained session could claim to be. Deliberately
-- omitting the write policies means the only path to a decision is the
-- backend's own trusted connection, gated by `marketplace:moderate`.
-- ------------------------------------------------------------
ALTER TABLE governance_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS catalogue_read ON governance_reviews;
CREATE POLICY catalogue_read ON governance_reviews FOR SELECT USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prismx_tenant;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prismx_tenant;
