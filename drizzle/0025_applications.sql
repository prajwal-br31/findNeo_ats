-- 025 — applications, the concurrent-application cap, and stage decisions
-- (06b §2, BR-055 through BR-065).

-- `job_pipeline_stages` was the one Phase 2 FK target that never got the
-- composite unique key every other one has, and `applications` is the first
-- table to reference it by `(id, company_id)`. Postgres requires a matching
-- unique constraint on the referenced side, so the FK below cannot be created
-- without this.
--
-- Added here rather than by editing 012, which has already been applied:
-- rewriting an applied migration leaves every database that ran the old
-- version silently different from the file that claims to describe it.
-- `IF NOT EXISTS` on the guard so a database provisioned after a future
-- squash does not fail on a constraint that is already there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ux_job_stages_id_company'
  ) THEN
    ALTER TABLE job_pipeline_stages
      ADD CONSTRAINT ux_job_stages_id_company UNIQUE (id, company_id);
  END IF;
END
$$;
--> statement-breakpoint

CREATE TABLE applications (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id               uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  job_id                   uuid        NOT NULL,
  candidate_id             uuid        NOT NULL,
  current_stage_id         uuid,
  status                   text        NOT NULL DEFAULT 'active',
  source                   text        NOT NULL,
  -- Drives commission attribution in Phase 6. Nullable and unused until then.
  source_agency_company_id uuid REFERENCES companies (id) ON DELETE SET NULL,
  source_engagement_id     uuid,
  owner_user_id            uuid,
  form_template_version_id uuid        NOT NULL REFERENCES form_template_versions (id),
  custom_fields            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  applied_at               timestamptz NOT NULL DEFAULT now(),
  closed_at                timestamptz,
  -- Non-destructive transfer (D-033): the source application is retained and
  -- the new one points back at it.
  transferred_from_id      uuid,

  -- Snapshot (D-009, BR-056). Frozen at submission and never updated. Named
  -- `snapshot_*` rather than sharing the candidate's column names so that
  -- every read site has to state which model it means, and a mapper reaching
  -- for the live profile by accident is visible in review.
  snapshot_full_name        text       NOT NULL,
  snapshot_email            citext,
  snapshot_phone            text,
  snapshot_current_title    text,
  snapshot_current_employer text,
  snapshot_experience_years numeric(4, 1),
  -- Masked, all three.
  snapshot_current_ctc      numeric(14, 2),
  snapshot_expected_ctc     numeric(14, 2),
  snapshot_notice_period_days smallint,
  snapshot_ctc_currency     char(3),
  snapshot_location         text,
  snapshot_education_level  text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_applications_status CHECK (status IN
    ('active','hired','rejected','withdrawn','transferred')),
  CONSTRAINT ck_applications_source CHECK (source IN
    ('career_site','internal_add','agency','pool_conversion','referral')),
  CONSTRAINT ux_applications_id_company UNIQUE (id, company_id),

  CONSTRAINT fk_applications_job
    FOREIGN KEY (job_id, company_id) REFERENCES jobs (id, company_id),
  CONSTRAINT fk_applications_candidate
    FOREIGN KEY (candidate_id, company_id) REFERENCES candidates (id, company_id),
  -- BR-063 at the schema level: a stage must belong to this tenant. That it
  -- belongs to *this job's* pipeline is checked by the service, because the
  -- composite FK can only reach as far as the tenant.
  CONSTRAINT fk_applications_stage
    FOREIGN KEY (current_stage_id, company_id)
    REFERENCES job_pipeline_stages (id, company_id),
  CONSTRAINT fk_applications_transferred_from
    FOREIGN KEY (transferred_from_id, company_id)
    REFERENCES applications (id, company_id),
  CONSTRAINT fk_applications_owner
    FOREIGN KEY (owner_user_id, company_id) REFERENCES users (id, company_id)
);
--> statement-breakpoint

-- Scoped to active (BR-059). A rejected candidate may reapply to the same job;
-- an unscoped unique index would bar that permanently.
CREATE UNIQUE INDEX ux_application_active_per_job ON applications (job_id, candidate_id)
  WHERE status = 'active';
--> statement-breakpoint

CREATE INDEX ix_applications_job_stage
  ON applications (company_id, job_id, current_stage_id) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX ix_applications_candidate
  ON applications (company_id, candidate_id, applied_at DESC);
--> statement-breakpoint
CREATE INDEX ix_applications_owner
  ON applications (company_id, owner_user_id) WHERE status = 'active';
--> statement-breakpoint
-- The index the Phase 6 hire-time cool-off resolution depends on (BR-075).
-- Created now, with the table, because adding it later against a large
-- applications table is the kind of migration that takes a maintenance window.
CREATE INDEX ix_applications_agency_lookback
  ON applications (candidate_id, company_id, applied_at)
  WHERE source_agency_company_id IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER trg_applications_touch
  BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint

-- Closes the loop left open in 024: a resume may now name the application it
-- was frozen for.
ALTER TABLE candidate_resumes
  ADD CONSTRAINT fk_resumes_application
  FOREIGN KEY (application_id, company_id) REFERENCES applications (id, company_id)
  ON DELETE CASCADE;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- T-061 — the concurrent application cap (BR-057, BR-058, D-012).
--
-- A unique index cannot express "at most N", so this is a trigger. The
-- `FOR UPDATE` on the candidate row is the entire point: without it two
-- simultaneous submissions both read a count below the cap and both insert.
-- The second transaction blocks on the lock until the first commits, then
-- sees the row it inserted.
--
-- The service must NOT pre-check the cap and skip the trigger. A check in
-- application code is a check-then-act race no matter how it is written.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_application_cap() RETURNS trigger AS $$
DECLARE
  cap           int;
  current_count int;
BEGIN
  -- Lock the candidate row first. Every concurrent submission for the same
  -- candidate serialises here, which is what makes the count below truthful.
  PERFORM 1 FROM candidates
   WHERE id = NEW.candidate_id AND company_id = NEW.company_id
     FOR UPDATE;

  -- Company override wins over the platform default; NULLS LAST puts the
  -- company row first when both exist.
  SELECT COALESCE((value #>> '{}')::int, 1)
    INTO cap
    FROM settings
   WHERE key = 'candidate.max_active_applications'
     AND (company_id = NEW.company_id OR company_id IS NULL)
   ORDER BY company_id NULLS LAST
   LIMIT 1;

  cap := COALESCE(cap, 1);

  SELECT count(*) INTO current_count
    FROM applications
   WHERE candidate_id = NEW.candidate_id
     AND company_id = NEW.company_id
     AND status = 'active';

  IF current_count >= cap THEN
    RAISE EXCEPTION 'application_cap_reached'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER trg_application_cap
  BEFORE INSERT ON applications
  FOR EACH ROW EXECUTE FUNCTION enforce_application_cap();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Stage decisions. Append-only; `hire` is recorded here at the final stage
-- (BR-065). Formal offer management is Phase 2 of the product (D-030).
-- ---------------------------------------------------------------------------

CREATE TABLE stage_decisions (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  application_id uuid        NOT NULL,
  from_stage_id  uuid,
  to_stage_id    uuid,
  decision       text        NOT NULL,
  decided_by     uuid        NOT NULL,
  -- Masked: internal commentary, never shown to an agency or a candidate.
  notes          text,
  decided_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_decision CHECK (decision IN ('advance','reject','hold','hire')),
  CONSTRAINT ux_stage_decisions_id_company UNIQUE (id, company_id),
  CONSTRAINT fk_decisions_application
    FOREIGN KEY (application_id, company_id) REFERENCES applications (id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_decisions_user
    FOREIGN KEY (decided_by, company_id) REFERENCES users (id, company_id)
);
--> statement-breakpoint

CREATE INDEX ix_decisions_application
  ON stage_decisions (company_id, application_id, decided_at DESC);
--> statement-breakpoint

CREATE TABLE decision_reasons (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  -- NULL = platform default, visible to every tenant. Same split-policy shape
  -- as `roles` and `settings`.
  company_id     uuid REFERENCES companies (id) ON DELETE CASCADE,
  decision_type  text        NOT NULL,
  key            text        NOT NULL,
  label          text        NOT NULL,
  is_active      boolean     NOT NULL DEFAULT true,
  sequence_order smallint    NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- `hold` has no reason catalog. Excluded, not forgotten (06b §2).
  CONSTRAINT ck_reason_type CHECK (decision_type IN ('reject','hire')),
  CONSTRAINT ux_decision_reasons_id_company UNIQUE (id, company_id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX ux_reason_platform
  ON decision_reasons (decision_type, key) WHERE company_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX ux_reason_company
  ON decision_reasons (company_id, decision_type, key) WHERE company_id IS NOT NULL;
--> statement-breakpoint

-- A join table rather than a column: one decision may carry several reasons.
CREATE TABLE stage_decision_reasons (
  stage_decision_id  uuid NOT NULL,
  decision_reason_id uuid NOT NULL REFERENCES decision_reasons (id),
  company_id         uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,

  PRIMARY KEY (stage_decision_id, decision_reason_id),
  CONSTRAINT fk_sdr_decision
    FOREIGN KEY (stage_decision_id, company_id) REFERENCES stage_decisions (id, company_id)
    ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX ix_sdr_reason ON stage_decision_reasons (company_id, decision_reason_id);
--> statement-breakpoint

GRANT UPDATE, DELETE ON applications TO findneo_app;
--> statement-breakpoint
-- Append-only by grant, not merely by convention: no UPDATE, no DELETE.
GRANT UPDATE, DELETE ON decision_reasons TO findneo_app;
--> statement-breakpoint
GRANT DELETE ON stage_decision_reasons TO findneo_app;
