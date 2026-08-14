-- 018 — resolve an invitation from its token, before a tenant is known.
--
-- The accept and preview routes are unauthenticated by necessity: the invitee
-- has no account and therefore no session, so nothing has bound a tenant.
-- `invitations` is under FORCE ROW LEVEL SECURITY, so an untenanted select
-- matches no rows and the token could never be redeemed.
--
-- Same treatment as the login lookup in migration 016, and for the same
-- reason: a SECURITY DEFINER function widens exactly one query, rather than a
-- policy widening every untenanted read of the table.
--
-- Matching is by token HASH — the raw token is never stored (ER-047), so a
-- database dump contains nothing that can be presented to accept an invite.

CREATE FUNCTION invitation_lookup_by_token(lookup_hash text)
RETURNS TABLE (
  id            uuid,
  company_id    uuid,
  email         citext,
  role_id       uuid,
  department_id uuid,
  status        text,
  expires_at    timestamptz,
  company_name  text
)
LANGUAGE sql
SECURITY DEFINER
-- Empty search_path: a SECURITY DEFINER function runs as its owner, so an
-- attacker-controlled search_path would let a shadowing object execute with
-- the migrator's rights. Every name below is schema-qualified.
SET search_path = ''
STABLE
AS $$
  SELECT i.id, i.company_id, i.email, i.role_id, i.department_id, i.status,
         i.expires_at, c.name
    FROM public.invitations i
    JOIN public.companies c ON c.id = i.company_id
   WHERE i.token_hash = lookup_hash
   LIMIT 1
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION invitation_lookup_by_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION invitation_lookup_by_token(text) TO findneo_app;
