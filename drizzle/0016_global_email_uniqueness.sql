-- 016 — user email becomes globally unique (D-049).
--
-- Amends the indexes migration 003 created. A separate migration rather than
-- an edit to 003 because 003 has already been applied: Drizzle records it as
-- done and will never re-run it, so an edit would take effect on fresh
-- installs and silently skip every existing database — the exact skip-version
-- failure ER-032 exists to prevent.
--
-- Replaces two indexes with one:
--
--   ux_users_company_email  (company_id, email) WHERE company_id IS NOT NULL
--   ux_users_platform_email (email)             WHERE company_id IS NULL
--     ->
--   ux_users_email          (email)             WHERE anonymized_at IS NULL
--
-- **Why global.** Login is email-first at one fixed domain (D-006), and the
-- tenant-scoped index permitted the same address in two companies. That made
-- the login lookup genuinely ambiguous: two candidate rows, and no way to
-- choose without asking for a company — which D-006's superseded table already
-- rejected. It also resolves O-011, since a platform-staff address can no
-- longer collide with a tenant user's; there is now one index over both.
--
-- **Why `WHERE anonymized_at IS NULL`.** Anonymisation (D-034) overwrites the
-- address in place. Two anonymised rows would otherwise collide with each
-- other, and an erased user would keep their address reserved forever.
--
-- Accepted limitation: one person cannot hold accounts at two companies under
-- one address. Given BR-005 that is close to the intended model already, and
-- the upgrade path is a disambiguation step AFTER password verification —
-- never before, because listing an address's companies pre-authentication is
-- an enumeration oracle (SEC-015).

DROP INDEX IF EXISTS ux_users_company_email;
--> statement-breakpoint
DROP INDEX IF EXISTS ux_users_platform_email;
--> statement-breakpoint

CREATE UNIQUE INDEX ux_users_email ON users (email) WHERE anonymized_at IS NULL;
--> statement-breakpoint

-- Login resolves a user by email with no tenant bound, so the lookup must be
-- able to see rows RLS would otherwise hide. `users` is under FORCE ROW LEVEL
-- SECURITY and the tenant policy matches nothing when the GUC is unset, which
-- means an untenanted SELECT returns zero rows — correct for every other
-- query in the system, and fatal for the one that has to run before a tenant
-- is known.
--
-- Resolved with a SECURITY DEFINER function rather than a policy, because a
-- policy would widen every untenanted read of `users`. This widens exactly
-- one query, returns exactly the columns authentication needs, and is
-- greppable as the single pre-tenant read path in the system.
--
-- It deliberately does NOT return `full_name`, `phone`, `mfa_secret_encrypted`
-- or anything else: an authentication lookup needs credentials and status, and
-- nothing here should become a convenient way to read a user.
CREATE FUNCTION auth_lookup_user_by_email(lookup_email citext)
RETURNS TABLE (
  id                 uuid,
  company_id         uuid,
  email              citext,
  password_hash      text,
  status             text,
  email_verified_at  timestamptz,
  mfa_enabled        boolean,
  failed_login_count smallint,
  locked_until       timestamptz
)
LANGUAGE sql
SECURITY DEFINER
-- Empty search_path: a SECURITY DEFINER function runs as its owner, so an
-- attacker-controlled search_path would let a shadowing object execute with
-- the migrator's rights. Every name below is schema-qualified.
SET search_path = ''
STABLE
AS $$
  SELECT u.id, u.company_id, u.email, u.password_hash, u.status,
         u.email_verified_at, u.mfa_enabled, u.failed_login_count, u.locked_until
    FROM public.users u
   WHERE u.email = lookup_email
     AND u.anonymized_at IS NULL
     -- Platform staff authenticate on the separate platform surface (08 §2).
     -- Letting them through the tenant endpoint would put staff credentials
     -- on a public route.
     AND u.company_id IS NOT NULL
   LIMIT 1
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_lookup_user_by_email(citext) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_lookup_user_by_email(citext) TO findneo_app;
--> statement-breakpoint

-- The counter updates on the login path have the same problem: they run
-- before a tenant is bound. Same treatment, same narrowness — these two write
-- nothing but the lockout bookkeeping, and neither can touch another column.
CREATE FUNCTION auth_record_failed_login(target_user uuid, threshold int, lock_minutes int)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.users
     SET failed_login_count = failed_login_count + 1,
         locked_until = CASE
           WHEN failed_login_count + 1 >= threshold
           THEN now() + make_interval(mins => lock_minutes)
           ELSE locked_until
         END
   WHERE id = target_user
$$;
--> statement-breakpoint

CREATE FUNCTION auth_record_successful_login(target_user uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.users
     SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
   WHERE id = target_user
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_record_failed_login(uuid, int, int) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_record_successful_login(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_record_failed_login(uuid, int, int) TO findneo_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_record_successful_login(uuid) TO findneo_app;
