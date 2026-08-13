-- Migration 001 — extensions, database roles, grants (06 §8).
--
-- Idempotent throughout: an on-premise customer may skip versions and a
-- migration must not assume the previous release is running (ER-032, SEC-074).
--
-- PRIVILEGES. Creating an extension and creating roles are cluster-level acts
-- that `findneo_migrator` deliberately cannot perform — it is NOCREATEROLE, so
-- that the role which runs migrations cannot mint itself new identities. On a
-- fresh install an operator runs this one migration as a superuser; every
-- later migration runs as `findneo_migrator`. Where the objects already exist
-- (the usual case, because `pnpm db:setup` creates them for development) each
-- block is a no-op and needs no privilege at all.

-- citext: case-insensitive email comparison without lower() on every query,
-- enforced by the column type rather than by remembering (06 §1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citext') THEN
    BEGIN
      CREATE EXTENSION citext;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION
        'citext is required (06 §1) but the current role cannot create it. '
        'Run: CREATE EXTENSION citext; as a superuser, then re-run migrations.';
    END;
  END IF;
END
$$;
--> statement-breakpoint

-- The three application roles (06 §2). None is a superuser and none owns a
-- table; `findneo_migrator` owns everything and never serves traffic.
--
-- Created without passwords on purpose. A password in a committed migration is
-- a committed secret (ER-046), and secrets are generated per install and never
-- shared between installations (SEC-073).
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['findneo_app', 'findneo_public', 'findneo_platform']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format(
          'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
          role_name
        );
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'role % is required (06 §2) but the current role cannot create it. '
          'Create the three application roles as a superuser, then re-run migrations.',
          role_name;
      END;
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint

-- Nothing is granted to PUBLIC. Every privilege below is named explicitly, so
-- a role can only reach what it was deliberately given.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO findneo_app, findneo_public, findneo_platform;
--> statement-breakpoint

GRANT USAGE, CREATE ON SCHEMA public TO findneo_migrator;
--> statement-breakpoint

-- Default privileges for tables `findneo_migrator` creates from here on.
--
-- SELECT and INSERT only, deliberately. UPDATE and DELETE are granted per
-- table in the migration that creates it. That inversion is what makes
-- append-only the default rather than the exception: `audit_logs` (migration
-- 009) must never receive UPDATE or DELETE (SEC-036, BR-096), and a blanket
-- default privilege would silently hand them over and require every future
-- audit-like table to remember to revoke. Forgetting an explicit grant is a
-- loud runtime error; forgetting a revoke is a silent security hole.
ALTER DEFAULT PRIVILEGES FOR ROLE findneo_migrator IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO findneo_app;
--> statement-breakpoint

-- `findneo_public` and `findneo_platform` receive no default privileges at
-- all. The public role's blast radius is bounded by grants rather than by
-- handler correctness (06 §2), so each of its grants is written out, one
-- table at a time, in the migration that needs it.
SELECT 1;
