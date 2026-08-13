-- 006 — the access-control tables (D-007).
--
-- `user_roles` supersedes `user_departments.role_id`, `organization_memberships`
-- and `membership_roles`, all of which appear in earlier handoff material and
-- are wrong. One mechanism answers "what may this person do".

-- Fixed platform-wide catalog. Companies compose these into roles; they cannot
-- invent permission types. No company_id and no RLS — global reference data.
CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  key         text NOT NULL,
  category    text NOT NULL,
  description text,

  CONSTRAINT uq_permissions_key UNIQUE (key)
);
--> statement-breakpoint

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  -- NULL = platform default role, visible to every company.
  company_id  uuid REFERENCES companies (id) ON DELETE CASCADE,
  key         text        NOT NULL,
  name        text        NOT NULL,
  scope       text        NOT NULL,
  -- false for platform defaults. A company may copy one, never edit it.
  is_editable boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_roles_scope CHECK (scope IN ('platform','company','department','job'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX ux_roles_platform_key ON roles (key) WHERE company_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX ux_roles_company_key ON roles (company_id, key) WHERE company_id IS NOT NULL;
--> statement-breakpoint

GRANT UPDATE, DELETE ON roles TO findneo_app;
--> statement-breakpoint

-- No RLS: reachable only through `roles`, which is already protected.
CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,

  PRIMARY KEY (role_id, permission_id)
);
--> statement-breakpoint

GRANT DELETE ON role_permissions TO findneo_app;
--> statement-breakpoint

CREATE TABLE user_roles (
  -- Surrogate rather than composite, because department_id is nullable and a
  -- composite PK over a nullable column does not work in PostgreSQL: NULLs
  -- are not equal to each other, so (user, role, NULL) could be inserted
  -- repeatedly. The two partial indexes below express the real rule.
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  role_id       uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  -- NULL = company-wide.
  department_id uuid,
  granted_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_user_roles_user
    FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_roles_department
    FOREIGN KEY (department_id, company_id) REFERENCES departments (id, company_id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE UNIQUE INDEX ux_user_roles_company_wide ON user_roles (user_id, role_id)
  WHERE department_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX ux_user_roles_scoped ON user_roles (user_id, role_id, department_id)
  WHERE department_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX ix_user_roles_lookup ON user_roles (company_id, user_id);
--> statement-breakpoint

GRANT UPDATE, DELETE ON user_roles TO findneo_app;
