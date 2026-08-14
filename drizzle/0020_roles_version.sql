-- 020 — `rolesVersion`, the per-company counter behind the permission cache.
--
-- Permission resolution is cached in-process, keyed `(companyId, userId,
-- rolesVersion)` (08 §3). The version is what makes a revocation take effect
-- on the *next request* rather than after a TTL expires — the cache key
-- changes, so every stale entry becomes unreachable at once without a flush
-- and without cross-process coordination.
--
-- A TTL alone would leave a revoked role live for the length of the TTL, which
-- is precisely the window that matters when someone is being removed for cause.

ALTER TABLE companies ADD COLUMN roles_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint

-- Bumped by a trigger rather than by the service.
--
-- Every path that changes an assignment has to bump it, and "every path"
-- includes ones that do not exist yet. A trigger cannot be forgotten by the
-- next feature; a call in RolesService can, and the failure is silent — stale
-- permissions served from cache with nothing to see in a log.
CREATE FUNCTION bump_roles_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target uuid;
BEGIN
  target := COALESCE(NEW.company_id, OLD.company_id);
  UPDATE companies SET roles_version = roles_version + 1 WHERE id = target;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- AFTER, and statement-level would be wrong here: the company id comes from
-- the row, so it has to be per-row.
CREATE TRIGGER trg_user_roles_bump_version
  AFTER INSERT OR UPDATE OR DELETE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION bump_roles_version();
--> statement-breakpoint

-- A role's own permission set changing matters just as much as an assignment:
-- editing a custom role rewrites what everyone holding it can do.
CREATE FUNCTION bump_roles_version_for_role() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target uuid;
BEGIN
  SELECT r.company_id INTO target
    FROM roles r WHERE r.id = COALESCE(NEW.role_id, OLD.role_id);

  -- A platform-default role has no company. Editing one is already refused by
  -- is_editable, and bumping every company would be a thundering-herd cache
  -- invalidation across the estate.
  IF target IS NOT NULL THEN
    UPDATE companies SET roles_version = roles_version + 1 WHERE id = target;
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_role_permissions_bump_version
  AFTER INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION bump_roles_version_for_role();
