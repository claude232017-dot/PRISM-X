-- ============================================================
-- PRISM-X — Row-Level Security
--
-- Tenant isolation is enforced in two independent layers:
--
--   1. Application layer — BaseRepository merges `organizationId` from the
--      authenticated RequestContext into every query. Always on, works with
--      connection pooling, and fails closed (no context => exception).
--
--   2. Database layer — the policies below. They evaluate
--      `current_setting('app.current_organization_id')`, which
--      PrismaService.withTenant() sets transaction-locally.
--
-- Why the owner is not FORCEd: the backend connects with a service-role
-- identity that is trusted to act across tenants for migrations, seeding and
-- background jobs — the same arrangement Supabase uses, where the service key
-- bypasses RLS and the anon/authenticated keys do not. Layer 1 constrains that
-- connection. These policies constrain everything else: PostgREST/supabase-js
-- clients, analytics tools, psql sessions, and any future service that reaches
-- the database without going through the repository layer.
--
-- `prismx_tenant` below is that constrained identity.
-- ============================================================

-- ------------------------------------------------------------
-- Helper: the organization the current session is pinned to.
-- Returns NULL when unset, which makes every policy fail closed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_organization_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')
$$;

-- ------------------------------------------------------------
-- A least-privilege role for any client that must be constrained by the
-- database itself. It deliberately lacks BYPASSRLS.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prismx_tenant') THEN
    CREATE ROLE prismx_tenant NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO prismx_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prismx_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prismx_tenant;

-- ------------------------------------------------------------
-- Policies: one per tenant-scoped table.
--
-- USING governs which rows are visible to SELECT/UPDATE/DELETE.
-- WITH CHECK governs which rows may be written, so a constrained client
-- cannot INSERT a row belonging to another organization.
-- ------------------------------------------------------------
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'workers', 'missions', 'tasks', 'knowledge', 'providers',
    'integrations', 'extensions', 'events', 'audit_logs',
    'credentials', 'memberships'
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
-- Organizations: a session may only see the organization it is pinned to.
-- ------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations
  USING ("id" = app_current_organization_id())
  WITH CHECK ("id" = app_current_organization_id());

-- ------------------------------------------------------------
-- Users: visible only through a membership in the pinned organization.
-- Users are global records, so the predicate goes through `memberships`
-- rather than a column on the row itself.
-- ------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m."userId" = users.id
        AND m."organizationId" = app_current_organization_id()
    )
  );

-- ------------------------------------------------------------
-- Roles: system roles are readable by everyone; custom roles only by the
-- organization that defined them.
-- ------------------------------------------------------------
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON roles;
CREATE POLICY tenant_isolation ON roles
  USING ("isSystem" = true OR "organizationId" = app_current_organization_id());

-- Permissions and role_permissions are global constants — readable, not writable.
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON permissions;
CREATE POLICY read_all ON permissions FOR SELECT USING (true);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON role_permissions;
CREATE POLICY read_all ON role_permissions FOR SELECT USING (true);
