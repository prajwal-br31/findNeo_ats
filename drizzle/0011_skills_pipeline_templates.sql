-- 011 — skills catalog and pipeline templates.

-- A normalized catalog rather than free text on job_skills, because the
-- Resume Ranker matches against these — and free text makes "React",
-- "ReactJS" and "react.js" three different skills (D-029).
CREATE TABLE skills (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  -- NULL = platform-seeded and shared by every company.
  company_id uuid REFERENCES companies (id) ON DELETE CASCADE,
  name       text        NOT NULL,
  -- Normalized for matching. Unknown skills are auto-created in the company's
  -- own scope on first use.
  slug       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX ux_skills_platform ON skills (slug) WHERE company_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX ux_skills_company ON skills (company_id, slug) WHERE company_id IS NOT NULL;
--> statement-breakpoint

GRANT UPDATE, DELETE ON skills TO findneo_app;
--> statement-breakpoint

CREATE TABLE pipeline_templates (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid REFERENCES companies (id) ON DELETE CASCADE,
  name       text        NOT NULL,
  status     text        NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_pipeline_templates_status CHECK (status IN ('active','archived'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX ux_pipeline_templates_platform ON pipeline_templates (name)
  WHERE company_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX ux_pipeline_templates_company ON pipeline_templates (company_id, name)
  WHERE company_id IS NOT NULL;
--> statement-breakpoint

GRANT UPDATE, DELETE ON pipeline_templates TO findneo_app;
--> statement-breakpoint

CREATE TABLE pipeline_template_stages (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  template_id    uuid     NOT NULL REFERENCES pipeline_templates (id) ON DELETE CASCADE,
  company_id     uuid,
  name           text     NOT NULL,
  sequence_order smallint NOT NULL,
  stage_type     text     NOT NULL,
  is_terminal    boolean  NOT NULL DEFAULT false,

  CONSTRAINT uq_pipeline_template_stage_order UNIQUE (template_id, sequence_order),
  CONSTRAINT ck_template_stage_type CHECK (stage_type IN
    ('applied','screening','interview','offer','hired','rejected'))
);
--> statement-breakpoint

GRANT UPDATE, DELETE ON pipeline_template_stages TO findneo_app;
