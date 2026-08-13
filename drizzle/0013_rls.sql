-- 013 — Row-Level Security: enable, force, policies.
--
-- Deliberately last and deliberately separate (06 §8). RLS enablement is the
-- single change most likely to be partially applied, and one reviewable
-- migration containing every policy is auditable in a way that scattering
-- them across the creating migrations is not. Its accompanying test asserts
-- that *every* table carrying a company_id has RLS enabled and forced, which
-- is the guard against someone adding a table later and forgetting.
--
-- Three things every policy below has in common:
--
--   ENABLE  turns policies on for non-owners.
--   FORCE   applies them to the owner too. Without it, findneo_migrator —
--           which owns every table — reads everything, and so would anything
--           that ever ran as the owner by mistake.
--   nullif  is not optional. A transaction-local GUC does not become
--           undefined when its transaction ends; it reverts to the EMPTY
--           STRING. So current_setting(..., true) returns NULL only on a
--           connection that has never bound a tenant, and '' on every
--           connection that has served one. ''::uuid raises
--           `invalid input syntax for type uuid` rather than yielding NULL,
--           which turns an untenanted query on a warm pooled connection into
--           a 500 instead of zero rows. It still fails closed, but SEC-003
--           requires the failure direction be "nothing, never everything" —
--           and on a warm pool, most connections are warm.
--
-- Two tables deliberately have no RLS: `permissions` is a global catalog with
-- no tenant column, and `role_permissions` is reachable only through `roles`,
-- which is protected. Both are asserted as intentional in the schema test
-- rather than left to be rediscovered.

-- companies: the one table where the tenant key is the primary key.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON companies
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- users: platform staff carry company_id IS NULL and therefore satisfy no
-- tenant policy — NULL = <uuid> is NULL, which is not true. Isolation from
-- platform accounts is automatic rather than conditional (D-005).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON users
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sessions
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON departments
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE user_departments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_departments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON user_departments
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- roles: the one documented deviation from the canonical policy (06 §4).
-- A company must READ platform defaults (company_id IS NULL), so the read
-- policy is widened. Writes stay strictly tenant-scoped, split into their own
-- policies, so a company can never modify or delete a platform default no
-- matter what its handler code does.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read_with_platform_defaults ON roles
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY tenant_insert ON roles
  AS PERMISSIVE FOR INSERT TO findneo_app
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_update ON roles
  AS PERMISSIVE FOR UPDATE TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_delete ON roles
  AS PERMISSIVE FOR DELETE TO findneo_app
  USING (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON user_roles
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- settings and field_visibility_rules: same shape as roles. Platform defaults
-- are readable by every tenant and writable by none.
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read_with_platform_defaults ON settings
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY tenant_insert ON settings
  AS PERMISSIVE FOR INSERT TO findneo_app
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_update ON settings
  AS PERMISSIVE FOR UPDATE TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_delete ON settings
  AS PERMISSIVE FOR DELETE TO findneo_app
  USING (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE field_visibility_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE field_visibility_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read_with_platform_defaults ON field_visibility_rules
  AS PERMISSIVE FOR SELECT TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY tenant_insert ON field_visibility_rules
  AS PERMISSIVE FOR INSERT TO findneo_app
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_update ON field_visibility_rules
  AS PERMISSIVE FOR UPDATE TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_delete ON field_visibility_rules
  AS PERMISSIVE FOR DELETE TO findneo_app
  USING (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outbox
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE activity_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON activity_logs
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- audit_logs is partitioned, which makes RLS two jobs rather than one.
--
-- PostgreSQL applies the policies of BOTH the partitioned parent and the
-- partition a row lands in. Enabling RLS on a partition without giving it a
-- policy therefore does not merely protect direct access — it denies every
-- insert through the parent as well. So each partition gets the same policy
-- the parent has.
--
-- Done in a loop because partition names are generated, and the `system`
-- domain will create more of them monthly. The same loop is what the schema
-- assertion in T-023 checks the result of.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_logs
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

DO $$
DECLARE
  partition_name text;
BEGIN
  FOR partition_name IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'audit_logs'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I'
      || ' AS PERMISSIVE FOR ALL TO findneo_app'
      || ' USING (company_id = nullif(current_setting(''app.current_company_id'', true), '''')::uuid)'
      || ' WITH CHECK (company_id = nullif(current_setting(''app.current_company_id'', true), '''')::uuid)',
      partition_name
    );
  END LOOP;
END
$$;
