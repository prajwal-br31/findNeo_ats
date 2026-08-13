-- Migration 001b — idempotency_keys (06 §7).
--
-- Out of sequence on purpose, and 06 §8 records why: the table has no foreign
-- keys and depends on nothing, and the middleware that uses it ships in Phase 0
-- (T-010). Untested middleware in production is a worse trade than an
-- out-of-order migration number.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Nullable: signup and password reset need idempotency before a tenant exists.
  company_id      uuid,
  key             text        NOT NULL,
  endpoint        text        NOT NULL,
  request_hash    text        NOT NULL,
  status          text        NOT NULL DEFAULT 'in_flight',
  response_status smallint,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT ck_idem_status CHECK (status IN ('in_flight', 'completed'))
);
--> statement-breakpoint

-- NULLS NOT DISTINCT is load-bearing, and 06 §7 omits it.
--
-- By default PostgreSQL treats NULLs as distinct in a unique index, so two
-- pre-tenant rows with the same endpoint and key would BOTH be permitted —
-- precisely the signup case the nullable company_id exists for. The whole
-- in_flight mechanism depends on the second insert colliding; without this it
-- silently does not, and the unauthenticated surface is the one place a
-- duplicate submission is most likely.
CREATE UNIQUE INDEX IF NOT EXISTS ux_idem_scope
  ON idempotency_keys (company_id, endpoint, key) NULLS NOT DISTINCT;
--> statement-breakpoint

-- Drives the reaper. Stays small: it only ever indexes live rows.
CREATE INDEX IF NOT EXISTS ix_idem_expiry ON idempotency_keys (expires_at);
--> statement-breakpoint

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Non-standard, as 06 §7 notes: the NULL-company rows must be reachable
-- before a tenant exists. They are scoped by `endpoint` and `key` in the
-- query, not by the policy — a pre-tenant row carries no tenant to scope by.
--
-- RLS lands here rather than waiting for migration 013 because 06 §10.9 and
-- the Phase 0 gate both require every company_id table to have it enabled and
-- forced. A tenant-scoped table without RLS, even briefly, is what D-001
-- exists to prevent. `nullif` per D-047(a).
CREATE POLICY tenant_isolation ON idempotency_keys
  AS PERMISSIVE FOR ALL TO findneo_app
  USING (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  )
  WITH CHECK (
    company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint

-- Default privileges grant SELECT and INSERT only (migration 001), so UPDATE
-- and DELETE are named here: UPDATE marks a reservation completed, DELETE
-- releases one whose handler failed and lets the reaper collect expired rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO findneo_app;
