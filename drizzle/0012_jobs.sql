-- 012 — jobs, skills on jobs, hiring team, and the per-job pipeline copy.

CREATE TABLE jobs (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id               uuid           NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  department_id            uuid           NOT NULL,
  title                    text           NOT NULL,
  description              text,
  status                   text           NOT NULL DEFAULT 'draft',
  -- Skips department visibility entirely. NOT an additional filter on top of
  -- the department check — see the row-scope query (08-lld-jobs §3).
  confidential             boolean        NOT NULL DEFAULT false,
  employment_type          text,
  work_mode                text,
  country_code             char(2),
  city                     text,
  location_text            text,
  headcount                smallint       NOT NULL DEFAULT 1,
  -- Masked fields. field_visibility_rules maps both to jobs.salary.read.
  salary_min               numeric(14, 2),
  salary_max               numeric(14, 2),
  salary_currency          char(3),
  salary_period            text,
  experience_min_years     numeric(4, 1),
  experience_max_years     numeric(4, 1),
  education_level          text,
  target_start_date        date,
  closes_at                timestamptz,
  publish_to_career_site   boolean        NOT NULL DEFAULT true,
  published_at             timestamptz,
  -- The version this job was created under. Pinned, so editing the template
  -- afterwards never alters how this job renders (BR-046).
  form_template_version_id uuid           NOT NULL REFERENCES form_template_versions (id),
  custom_fields            jsonb          NOT NULL DEFAULT '{}'::jsonb,
  created_by               uuid           NOT NULL REFERENCES users (id),
  created_at               timestamptz    NOT NULL DEFAULT now(),
  updated_at               timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT ck_jobs_status CHECK (status IN ('draft','open','on_hold','closed')),
  CONSTRAINT ck_jobs_employment_type CHECK (employment_type IS NULL OR employment_type IN
    ('full_time','part_time','contract','internship','temporary')),
  CONSTRAINT ck_jobs_work_mode CHECK (work_mode IS NULL OR work_mode IN
    ('onsite','hybrid','remote')),
  CONSTRAINT ck_jobs_salary_period CHECK (salary_period IS NULL OR salary_period IN
    ('annual','monthly','hourly')),
  CONSTRAINT ck_jobs_salary CHECK (
    salary_max IS NULL OR salary_min IS NULL OR salary_max >= salary_min),
  CONSTRAINT ck_jobs_headcount CHECK (headcount > 0),
  CONSTRAINT fk_jobs_department
    FOREIGN KEY (department_id, company_id) REFERENCES departments (id, company_id),
  -- Composite FK target for job_skills, job_hiring_team and
  -- job_pipeline_stages, so none of them can attach to another tenant's job.
  CONSTRAINT ux_jobs_id_company UNIQUE (id, company_id)
);
--> statement-breakpoint

-- **There is deliberately no CHECK coupling `confidential` and
-- `publish_to_career_site`.** A CHECK would make "mark this already-published
-- job confidential" fail with a constraint violation, when the correct
-- behaviour is for it to succeed and withdraw the job from the public site.
-- The flags stay independent and exposure is prevented at the role boundary,
-- by the findneo_public policy in migration 013's successor below.

CREATE INDEX ix_jobs_company_status ON jobs (company_id, status, created_at DESC);
--> statement-breakpoint
CREATE INDEX ix_jobs_company_dept ON jobs (company_id, department_id) WHERE status <> 'closed';
--> statement-breakpoint
CREATE INDEX ix_jobs_custom_fields ON jobs USING gin (custom_fields);
--> statement-breakpoint

-- Matches the public policy predicate exactly, so the policy costs nothing at
-- runtime.
CREATE INDEX ix_jobs_public ON jobs (company_id, published_at DESC)
  WHERE status = 'open' AND publish_to_career_site AND NOT confidential;
--> statement-breakpoint

GRANT UPDATE, DELETE ON jobs TO findneo_app;
--> statement-breakpoint

CREATE TABLE job_skills (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid          NOT NULL,
  job_id         uuid          NOT NULL,
  skill_id       uuid          NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  min_years      numeric(4, 1),
  is_mandatory   boolean       NOT NULL DEFAULT false,
  weight         smallint      NOT NULL DEFAULT 5,
  sequence_order smallint,

  CONSTRAINT uq_job_skills UNIQUE (job_id, skill_id),
  CONSTRAINT ck_job_skills_weight CHECK (weight BETWEEN 1 AND 10),
  CONSTRAINT fk_job_skills_job
    FOREIGN KEY (job_id, company_id) REFERENCES jobs (id, company_id) ON DELETE CASCADE
);
--> statement-breakpoint

GRANT UPDATE, DELETE ON job_skills TO findneo_app;
--> statement-breakpoint

-- The sole source of job-level assignment (D-008). Two systems answering "who
-- works on this job" is how authorization bugs are born, which is why
-- user_roles has no job_id column.
CREATE TABLE job_hiring_team (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid        NOT NULL,
  job_id     uuid        NOT NULL,
  user_id    uuid        NOT NULL,
  team_role  text        NOT NULL,
  added_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_job_hiring_team UNIQUE (job_id, user_id, team_role),
  CONSTRAINT ck_team_role CHECK (team_role IN
    ('hiring_manager','recruiter','coordinator','interviewer')),
  CONSTRAINT fk_hiring_team_job
    FOREIGN KEY (job_id, company_id) REFERENCES jobs (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_hiring_team_user
    FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id) ON DELETE CASCADE
);
--> statement-breakpoint

-- Serves the hot path: "which jobs can this user see", evaluated on nearly
-- every list request through the row-scope predicate.
CREATE INDEX ix_hiring_team_user ON job_hiring_team (company_id, user_id);
--> statement-breakpoint

GRANT UPDATE, DELETE ON job_hiring_team TO findneo_app;
--> statement-breakpoint

-- A one-time copy taken at job creation, permanently independent of the
-- template afterwards. Editing a template never alters a live job's pipeline.
CREATE TABLE job_pipeline_stages (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid     NOT NULL,
  job_id         uuid     NOT NULL,
  name           text     NOT NULL,
  sequence_order smallint NOT NULL,
  stage_type     text     NOT NULL,
  is_terminal    boolean  NOT NULL DEFAULT false,

  -- Unique per job, so a naive reorder violates it mid-update. Resolved with
  -- the two-phase shift in 08-lld-jobs §4 — NOT with a deferrable constraint.
  -- Two mechanisms for one problem produce intermittent failures nobody can
  -- reproduce, so this stays immediate and the service does the shift.
  CONSTRAINT uq_job_stage_order UNIQUE (job_id, sequence_order),
  CONSTRAINT ck_stage_type CHECK (stage_type IN
    ('applied','screening','interview','offer','hired','rejected')),
  CONSTRAINT fk_job_stages_job
    FOREIGN KEY (job_id, company_id) REFERENCES jobs (id, company_id) ON DELETE CASCADE
);
--> statement-breakpoint

GRANT UPDATE, DELETE ON job_pipeline_stages TO findneo_app;
