-- 009 — outbox, audit_logs, activity_logs.

-- Transactional outbox (D-031). An event is written in the same transaction
-- as the state change that produced it, so the two cannot disagree.
CREATE TABLE outbox (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid,
  event_type     text        NOT NULL,
  event_version  smallint    NOT NULL DEFAULT 1,
  aggregate_type text        NOT NULL,
  aggregate_id   uuid        NOT NULL,
  -- Ids and metadata only, never personal data (ER-048). This table is read
  -- by the relay, logged on failure, and retained far longer than the row it
  -- describes.
  payload        jsonb       NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       smallint    NOT NULL DEFAULT 0,
  last_error     text
);
--> statement-breakpoint

-- Partial: it only ever contains the backlog, so it stays small no matter how
-- large the table grows.
CREATE INDEX ix_outbox_unpublished ON outbox (occurred_at) WHERE published_at IS NULL;
--> statement-breakpoint

GRANT UPDATE, DELETE ON outbox TO findneo_app;
--> statement-breakpoint

-- Compliance-grade field-level diffs. Partitioned monthly from the first
-- migration: converting a large unpartitioned audit table later is a painful
-- outage, and this is the table least likely to be small.
CREATE TABLE audit_logs (
  id             uuid        NOT NULL DEFAULT uuidv7(),
  company_id     uuid        NOT NULL,
  actor_user_id  uuid,
  actor_role_key text,
  action         text        NOT NULL,
  entity_type    text        NOT NULL,
  entity_id      uuid        NOT NULL,
  changes        jsonb,
  ip_address     inet,
  trace_id       text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- The partition key must be part of every unique constraint, so the PK is
  -- composite. `id` alone is still unique in practice — uuidv7 is unique
  -- regardless of partition — but PostgreSQL cannot enforce that globally.
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
--> statement-breakpoint

CREATE INDEX ix_audit_logs_company_entity
  ON audit_logs (company_id, entity_type, entity_id, created_at DESC);
--> statement-breakpoint

-- A default partition so an insert can never fail for want of a partition.
-- Attaching a new range partition then has to scan it, which is why the
-- `system` domain creates next month's partition ahead of time rather than
-- letting rows accumulate here.
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
--> statement-breakpoint

-- Append-only (SEC-036): INSERT and SELECT come from the default privileges
-- in migration 001, and UPDATE and DELETE are deliberately never granted.
-- This is why those defaults are SELECT+INSERT rather than full DML — a
-- blanket default would have handed these over and required a revoke here
-- that someone would eventually forget to write.
--
-- No GRANT statement follows. That absence is the control.

CREATE TABLE activity_logs (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid        NOT NULL,
  actor_user_id uuid,
  entity_type   text        NOT NULL,
  entity_id     uuid        NOT NULL,
  -- Pre-rendered user-facing summary, distinct from audit_logs' field diffs.
  summary       text        NOT NULL,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX ix_activity_logs_lookup
  ON activity_logs (company_id, entity_type, entity_id, created_at DESC);
--> statement-breakpoint

-- Append-only for the same reason as audit_logs: an activity feed that can be
-- edited after the fact is not a record of anything. No UPDATE, no DELETE.
SELECT 1;
