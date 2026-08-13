-- 002 — companies. The single tenant entity (D-001, D-035).
--
-- `owner_user_id` is declared here but its foreign key waits for 004: the
-- reference is circular (companies.owner_user_id -> users.id while
-- users.company_id -> companies.id) and is resolved by leaving the column
-- nullable and setting it inside the signup transaction, not by a deferrable
-- constraint (06 §3).

CREATE TABLE companies (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  name          text        NOT NULL,
  -- Globally unique, not tenant-scoped: it addresses the public career site.
  slug          text        NOT NULL,
  -- Bitwise (D-035): 1 = organisation, 2 = agency, 3 = both. Future types
  -- take 4 and 8 with no schema change, which is the point of a flag rather
  -- than an enum — a dual-capacity business is one row, not two.
  company_type  smallint    NOT NULL DEFAULT 1,
  status        text        NOT NULL DEFAULT 'pending_verification',
  plan_tier     text        NOT NULL DEFAULT 'trial',
  owner_user_id uuid,
  country_code  char(2)     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_companies_type CHECK (company_type BETWEEN 1 AND 3),
  CONSTRAINT ck_companies_slug CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  CONSTRAINT ck_companies_status CHECK (status IN ('pending_verification','active','suspended')),
  CONSTRAINT uq_companies_slug UNIQUE (slug)
);
--> statement-breakpoint

-- Default privileges cover SELECT and INSERT only (06 §2). A company row is
-- updated (status, owner) but never deleted by the application: closing an
-- account is a status change, and a DELETE would cascade across every tenant
-- table in the system.
GRANT UPDATE ON companies TO findneo_app;
