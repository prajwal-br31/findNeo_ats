-- 008 — settings and field visibility rules.
--
-- Both follow the same pattern: company_id NULL is the platform default, and
-- a company row overrides it. Resolution is ORDER BY company_id NULLS LAST
-- LIMIT 1, so the tenant's own row wins when present.

CREATE TABLE settings (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid REFERENCES companies (id) ON DELETE CASCADE,
  key        text        NOT NULL,
  value      jsonb       NOT NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX ux_settings_platform_key ON settings (key) WHERE company_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX ux_settings_company_key ON settings (company_id, key)
  WHERE company_id IS NOT NULL;
--> statement-breakpoint

GRANT UPDATE, DELETE ON settings TO findneo_app;
--> statement-breakpoint

-- Maps (company_id, table_name, field_name) -> required permission. No row
-- means unmasked. Masking is applied at serialization, after row access
-- resolves (D-025): PostgreSQL RLS cannot mask individual columns, which is
-- what makes ER-025's allowlist serialization the enforcement point.
CREATE TABLE field_visibility_rules (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id             uuid REFERENCES companies (id) ON DELETE CASCADE,
  table_name             text        NOT NULL,
  field_name             text        NOT NULL,
  required_permission_id uuid        NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  created_at             timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX ux_fvr_platform ON field_visibility_rules (table_name, field_name)
  WHERE company_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX ux_fvr_company ON field_visibility_rules (company_id, table_name, field_name)
  WHERE company_id IS NOT NULL;
--> statement-breakpoint

GRANT UPDATE, DELETE ON field_visibility_rules TO findneo_app;
