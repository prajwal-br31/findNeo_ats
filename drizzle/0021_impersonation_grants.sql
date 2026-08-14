-- 021 — time-boxed, audited impersonation grants (T-033, D-005, BR-006).
--
-- Platform staff hold no tenant permission at all (04 §3). Reaching tenant
-- data requires a grant that is time-boxed, carries a stated reason, and is
-- visible to the tenant's own Super Admin. Without an active grant, platform
-- staff get 404 on tenant data — never 403 (SEC-026), because 403 would
-- confirm the company exists.

CREATE TABLE impersonation_grants (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  -- The tenant being entered. Not nullable: a grant with no target is a grant
  -- over everything.
  company_id     uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  -- Platform staff, so company_id on this user is NULL. A plain FK, not the
  -- composite tenant-safe one, precisely because the actor is outside every
  -- tenant.
  platform_user_id uuid      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Required, and required to be non-trivial. "debugging" is not a reason; the
  -- CHECK sets a floor that makes someone type an actual sentence.
  reason         text        NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  ended_at       timestamptz,

  CONSTRAINT ck_impersonation_reason CHECK (length(btrim(reason)) >= 10)
);
--> statement-breakpoint

-- The lookup the authorization path makes on every impersonated request:
-- "is there a live grant for this staff member into this company".
CREATE INDEX ix_impersonation_active
  ON impersonation_grants (platform_user_id, company_id)
  WHERE ended_at IS NULL;
--> statement-breakpoint

CREATE INDEX ix_impersonation_company ON impersonation_grants (company_id, granted_at DESC);
--> statement-breakpoint

-- RLS, so the tenant's Super Admin can read grants against their own company
-- and nobody else's (BR-006). The row is tenant-scoped even though the actor
-- is not.
ALTER TABLE impersonation_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE impersonation_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON impersonation_grants
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

GRANT UPDATE ON impersonation_grants TO findneo_app;
--> statement-breakpoint

-- Creating and ending a grant happens with no tenant bound: the platform user
-- is outside every tenant and has nothing to bind to. Same SECURITY DEFINER
-- treatment as the other pre-tenant paths, and just as narrow — it can create
-- a grant and read one back, and it cannot read anything else.
CREATE FUNCTION impersonation_grant_create(
  target_company uuid,
  staff_user     uuid,
  stated_reason  text,
  valid_minutes  int
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.impersonation_grants (company_id, platform_user_id, reason, expires_at)
  VALUES (target_company, staff_user, stated_reason, now() + make_interval(mins => valid_minutes))
  RETURNING id
$$;
--> statement-breakpoint

CREATE FUNCTION impersonation_grant_active(grant_id uuid)
RETURNS TABLE (id uuid, company_id uuid, platform_user_id uuid, expires_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT g.id, g.company_id, g.platform_user_id, g.expires_at
    FROM public.impersonation_grants g
   WHERE g.id = grant_id AND g.ended_at IS NULL AND g.expires_at > now()
$$;
--> statement-breakpoint

CREATE FUNCTION impersonation_grant_end(grant_id uuid, staff_user uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ended AS (
    UPDATE public.impersonation_grants
       SET ended_at = now()
     -- Scoped to the staff member who holds it: ending someone else's session
     -- is not something this endpoint does.
     WHERE id = grant_id AND platform_user_id = staff_user AND ended_at IS NULL
     RETURNING 1
  )
  SELECT count(*)::int FROM ended
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION impersonation_grant_create(uuid, uuid, text, int) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION impersonation_grant_active(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION impersonation_grant_end(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION impersonation_grant_create(uuid, uuid, text, int) TO findneo_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION impersonation_grant_active(uuid) TO findneo_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION impersonation_grant_end(uuid, uuid) TO findneo_app;
--> statement-breakpoint

-- Platform staff authenticate against the same users table with company_id
-- NULL, and the login lookup in migration 016 deliberately excludes them. The
-- platform surface needs its own, which is that function's mirror image.
CREATE FUNCTION platform_lookup_user_by_email(lookup_email citext)
RETURNS TABLE (
  id                 uuid,
  email              citext,
  password_hash      text,
  status             text,
  mfa_enabled        boolean,
  failed_login_count smallint,
  locked_until       timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT u.id, u.email, u.password_hash, u.status, u.mfa_enabled,
         u.failed_login_count, u.locked_until
    FROM public.users u
   WHERE u.email = lookup_email
     AND u.anonymized_at IS NULL
     AND u.company_id IS NULL
   LIMIT 1
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION platform_lookup_user_by_email(citext) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_lookup_user_by_email(citext) TO findneo_app;
