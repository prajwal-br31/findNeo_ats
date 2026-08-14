-- 017 — close the other half of BR-011.
--
-- `trg_owner_requires_mfa` (migration 014) fires on `user_roles`, so it stops
-- a grant to a user without MFA. It does not fire on `users`, so turning MFA
-- off *after* the grant was unguarded — and reached exactly the state the
-- first trigger exists to prevent, by a supported route:
--
--   grant with mfa_enabled = true, then UPDATE users SET mfa_enabled = false
--     -> grant survives, super_admin now holds no MFA
--
-- `POST /v1/users/current/actions/disable-mfa` is on the endpoint list, so
-- this is not a theoretical path. Guarded here rather than in that handler
-- because the invariant is the database's: an application-layer check is one
-- a background job, a migration script or a second service will route around.

CREATE FUNCTION enforce_super_admin_keeps_mfa() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only the true -> false transition matters. Every other update to the row
  -- is none of this trigger's business, and firing on them would make an
  -- unrelated profile edit fail for a user who happens to be an owner.
  IF NEW.mfa_enabled IS NOT FALSE OR OLD.mfa_enabled IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = NEW.id AND r.key = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super_admin cannot disable mfa (BR-011)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- BEFORE, matching trg_owner_requires_mfa: the row must never take the
-- offending value, not even within the transaction.
CREATE TRIGGER trg_super_admin_keeps_mfa
  BEFORE UPDATE OF mfa_enabled ON users
  FOR EACH ROW EXECUTE FUNCTION enforce_super_admin_keeps_mfa();
