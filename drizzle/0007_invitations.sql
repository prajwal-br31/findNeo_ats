-- 007 — invitations.

CREATE TABLE invitations (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  email         citext      NOT NULL,
  role_id       uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  department_id uuid,
  invited_by    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Hashed, never raw (ER-047). A database dump must not contain anything
  -- that can be presented to accept an invitation.
  token_hash    text        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending',
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_invitations_status CHECK (status IN ('pending','accepted','expired','revoked')),
  CONSTRAINT uq_invitations_token_hash UNIQUE (token_hash),
  CONSTRAINT fk_invitations_department
    FOREIGN KEY (department_id, company_id) REFERENCES departments (id, company_id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX ix_invitations_company_status ON invitations (company_id, status);
--> statement-breakpoint

-- Prevents invitation spam to the same address: one pending invitation per
-- email per company, while still allowing a fresh one after revocation.
CREATE UNIQUE INDEX ux_invitations_pending_email ON invitations (company_id, email)
  WHERE status = 'pending';
--> statement-breakpoint

GRANT UPDATE, DELETE ON invitations TO findneo_app;
