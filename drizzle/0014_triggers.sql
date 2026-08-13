-- 014 — triggers.
--
-- `trg_owner_requires_mfa` blocks granting Super Admin to a user who has not
-- enrolled in MFA (D-006, BR-011). It lives in the database because it is a
-- security invariant, not a workflow preference: an invariant enforced only in
-- application code is an invariant that a background job, a migration script,
-- or a second service will eventually route around.
--
-- **It is not exempted for the founding grant** (D-050). An exempted security
-- trigger is a trigger with a hole, and the founding assignment is precisely
-- the one that matters most — it creates the account that can reassign every
-- permission in the tenant. Signup therefore does not grant the role at all;
-- the grant moves to the end of MFA enrolment.

CREATE FUNCTION enforce_owner_requires_mfa() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  role_key text;
  has_mfa  boolean;
BEGIN
  SELECT r.key INTO role_key FROM roles r WHERE r.id = NEW.role_id;

  -- Only the Super Admin grant is gated. Every other role is assignable
  -- without MFA; requiring it everywhere would push people to share the
  -- owner account, which is worse than the thing being prevented.
  IF role_key IS DISTINCT FROM 'super_admin' THEN
    RETURN NEW;
  END IF;

  SELECT u.mfa_enabled INTO has_mfa FROM users u WHERE u.id = NEW.user_id;

  IF has_mfa IS NOT TRUE THEN
    RAISE EXCEPTION 'super_admin requires mfa_enabled (BR-011)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- BEFORE, not AFTER: the row must never exist, not even within the
-- transaction. An AFTER trigger would let a same-transaction read see a grant
-- that is about to be rolled back.
--
-- UPDATE is covered as well as INSERT — repointing an existing assignment at
-- the super_admin role is the same grant by another route.
CREATE TRIGGER trg_owner_requires_mfa
  BEFORE INSERT OR UPDATE OF role_id, user_id ON user_roles
  FOR EACH ROW EXECUTE FUNCTION enforce_owner_requires_mfa();
--> statement-breakpoint

-- `updated_at` maintenance, so no writer can forget it. Applied only to the
-- tables that carry the column.
CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_settings_updated_at
  BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
