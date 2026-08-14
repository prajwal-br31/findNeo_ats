-- 019 — resolve a session from its refresh token, before a tenant is known.
--
-- Refresh is cookie-authenticated: the caller presents a refresh token and
-- nothing else, so no tenant is bound when the lookup runs and `sessions` is
-- under FORCE RLS. Same treatment as the login lookup (016) and the invitation
-- lookup (018), and for the same reason — a narrow SECURITY DEFINER function
-- rather than a policy that would widen every untenanted read of the table.
--
-- Matched by hash. The raw refresh token is never stored.

CREATE FUNCTION session_lookup_by_token(lookup_hash text)
RETURNS TABLE (
  id              uuid,
  user_id         uuid,
  company_id      uuid,
  family_id       uuid,
  active_capability smallint,
  expires_at      timestamptz,
  revoked_at      timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT s.id, s.user_id, s.company_id, s.family_id, s.active_capability,
         s.expires_at, s.revoked_at
    FROM public.sessions s
   WHERE s.refresh_token_hash = lookup_hash
   LIMIT 1
$$;
--> statement-breakpoint

-- Revokes every session in a family, in one statement.
--
-- This is the reuse-detection response (08 §3 step 3): presenting a token that
-- has already been rotated means the token was stolen, so the legitimate
-- holder is logged out deliberately rather than left sharing an account with
-- whoever replayed it.
--
-- SECURITY DEFINER for the same reason as the lookup: it runs on the refresh
-- path, which has no tenant bound. It cannot revoke across families — the
-- family id comes from a row the caller already proved they hold a token for.
CREATE FUNCTION session_revoke_family(target_family uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH revoked AS (
    UPDATE public.sessions SET revoked_at = now()
     WHERE family_id = target_family AND revoked_at IS NULL
     RETURNING 1
  )
  SELECT count(*)::int FROM revoked
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION session_lookup_by_token(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION session_revoke_family(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION session_lookup_by_token(text) TO findneo_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION session_revoke_family(uuid) TO findneo_app;
