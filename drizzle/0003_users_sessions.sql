-- 003 — users and sessions.
--
-- `users` is global identity for internal actors only. Candidates are never
-- in this table (D-015) — they have a separate lifecycle and separate
-- retention, and conflating them puts candidate PII behind staff auth.

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  -- NULL only for platform staff (D-005). That NULL is what makes isolation
  -- from platform accounts automatic rather than conditional: NULL = <uuid>
  -- evaluates to NULL, never true, so a platform row satisfies no tenant
  -- policy without anybody having to remember to exclude it.
  company_id           uuid REFERENCES companies (id) ON DELETE CASCADE,
  email                citext      NOT NULL,
  -- NULL when auth_provider <> 'password'. argon2id (SEC-014).
  password_hash        text,
  full_name            text        NOT NULL,
  phone                text,
  status               text        NOT NULL DEFAULT 'pending',
  email_verified_at    timestamptz,
  mfa_enabled          boolean     NOT NULL DEFAULT false,
  mfa_secret_encrypted text,
  auth_provider        text        NOT NULL DEFAULT 'password',
  provider_subject_id  text,
  last_login_at        timestamptz,
  -- Lockout is inline. There is no login_attempts table; it never existed
  -- despite appearing in prior handoff documents (06 §3).
  failed_login_count   smallint    NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  anonymized_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_users_status CHECK (status IN ('pending','active','suspended','deactivated')),
  CONSTRAINT ck_users_auth_provider CHECK (auth_provider IN ('password','sso')),
  -- Looks redundant against the primary key. It is not: it is the target
  -- every composite tenant-safe FK points at, and without it those FKs
  -- cannot be declared at all.
  CONSTRAINT ux_users_id_company UNIQUE (id, company_id)
);
--> statement-breakpoint

-- Email is unique per tenant, and separately unique across platform staff.
-- Two partial indexes rather than one composite over (company_id, email):
-- NULL is not equal to NULL, so platform rows would have no uniqueness at all
-- under the composite form.
CREATE UNIQUE INDEX ux_users_company_email ON users (company_id, email)
  WHERE company_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX ux_users_platform_email ON users (email)
  WHERE company_id IS NULL;
--> statement-breakpoint
CREATE INDEX ix_users_company_created ON users (company_id, created_at DESC);
--> statement-breakpoint

-- Updated, never deleted: deactivation is a status change, so audit history
-- keeps a resolvable actor. Anonymisation (D-034) overwrites in place and is
-- also an UPDATE.
GRANT UPDATE ON users TO findneo_app;
--> statement-breakpoint

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Denormalized for RLS, and always equal to users.company_id. Under D-014
  -- a session is always scoped to the user's own company; an agency reaches
  -- client data through agency_engagements, never by rebinding context.
  company_id         uuid,
  -- 1 = organisation view, 2 = agency view (D-035).
  active_capability  smallint    NOT NULL DEFAULT 1,
  -- Refresh-token family, needed from day one. Reuse detection revokes the
  -- whole family; adding the column later leaves every live session
  -- unprotected until it expires.
  family_id          uuid        NOT NULL,
  refresh_token_hash text        NOT NULL,
  rotated_from_id    uuid REFERENCES sessions (id) ON DELETE SET NULL,
  device_info        text,
  ip_address         inet,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,

  CONSTRAINT uq_sessions_refresh_hash UNIQUE (refresh_token_hash)
);
--> statement-breakpoint

CREATE INDEX ix_sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX ix_sessions_family ON sessions (family_id);
--> statement-breakpoint

-- UPDATE to revoke, DELETE to reap expired rows.
GRANT UPDATE, DELETE ON sessions TO findneo_app;
