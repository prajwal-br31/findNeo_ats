-- 010 — smart forms (D-028). Three tables.
--
-- Fields hang off a **version**, not a template. That is the whole point: a
-- job pins the version it was created under, so publishing v2 leaves every
-- v1 job rendering with v1's fields (BR-046). Hanging fields off the template
-- would make every historical record re-render under whatever the form says
-- today, which is a silent rewrite of what someone actually filled in.

CREATE TABLE form_templates (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  -- NULL = platform default, inherited by every company that has not
  -- configured its own.
  company_id    uuid REFERENCES companies (id) ON DELETE CASCADE,
  entity_type   text        NOT NULL,
  -- Deliberately inert in v1 (D-028b), and documented so nobody removes it as
  -- dead schema. The resolution function has a department branch that is
  -- unreachable until it is populated.
  department_id uuid,
  name          text        NOT NULL,
  status        text        NOT NULL DEFAULT 'active',
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_form_templates_entity CHECK (entity_type IN ('job','application')),
  CONSTRAINT ck_form_templates_status CHECK (status IN ('active','archived'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX ux_form_templates_platform ON form_templates (entity_type)
  WHERE company_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX ux_form_templates_company ON form_templates (company_id, entity_type)
  WHERE company_id IS NOT NULL AND department_id IS NULL;
--> statement-breakpoint

GRANT UPDATE, DELETE ON form_templates TO findneo_app;
--> statement-breakpoint

CREATE TABLE form_template_versions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  template_id  uuid        NOT NULL REFERENCES form_templates (id) ON DELETE CASCADE,
  -- Denormalized for RLS: a version must be reachable by policy without a
  -- join back to its template.
  company_id   uuid,
  version_no   integer     NOT NULL,
  status       text        NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  published_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_form_versions_status CHECK (status IN ('draft','published','archived')),
  CONSTRAINT uq_form_versions_number UNIQUE (template_id, version_no)
);
--> statement-breakpoint

-- One published version at a time. Publishing a new one archives its
-- predecessor; the index is what makes that an invariant rather than a
-- convention the publish path is trusted to maintain.
CREATE UNIQUE INDEX ux_form_versions_published ON form_template_versions (template_id)
  WHERE status = 'published';
--> statement-breakpoint

GRANT UPDATE, DELETE ON form_template_versions TO findneo_app;
--> statement-breakpoint

CREATE TABLE form_template_fields (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  version_id      uuid        NOT NULL REFERENCES form_template_versions (id) ON DELETE CASCADE,
  company_id      uuid,
  -- The JSON key inside `custom_fields`. Constrained so a field key can never
  -- be something that needs escaping wherever it lands.
  key             text        NOT NULL,
  label           text        NOT NULL,
  help_text       text,
  data_type       text        NOT NULL,
  is_required     boolean     NOT NULL DEFAULT false,
  options         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  max_length      integer,
  min_value       numeric,
  max_value       numeric,
  section         text,
  sequence_order  smallint    NOT NULL,
  -- Reserved for D-028a and read by nothing in v1. The compiler ignores it.
  visibility_rule jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_form_fields_key UNIQUE (version_id, key),
  CONSTRAINT ck_field_key CHECK (key ~ '^[a-z][a-z0-9_]{0,48}$'),
  CONSTRAINT ck_field_type CHECK (data_type IN
    ('text','long_text','number','date','boolean','select','multi_select'))
);
--> statement-breakpoint

CREATE INDEX ix_form_fields_version ON form_template_fields (version_id, sequence_order);
--> statement-breakpoint

GRANT UPDATE, DELETE ON form_template_fields TO findneo_app;
