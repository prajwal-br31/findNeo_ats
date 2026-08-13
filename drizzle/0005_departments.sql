-- 005 — departments and membership.
--
-- Flat, single level. Hierarchy is not in v1 and no parent_id is reserved:
-- unlike a spare column, a hierarchy is a genuine redesign of every scope
-- query, so reserving the column would not actually make it cheap (06 §3).

CREATE TABLE departments (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name         text        NOT NULL,
  head_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  status       text        NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_departments_status CHECK (status IN ('active','archived')),
  CONSTRAINT uq_departments_company_name UNIQUE (company_id, name),
  CONSTRAINT ux_departments_id_company UNIQUE (id, company_id)
);
--> statement-breakpoint

GRANT UPDATE, DELETE ON departments TO findneo_app;
--> statement-breakpoint

-- Membership only. No role_id (D-007) — role assignment lives in user_roles,
-- and two tables answering "what may this person do" is how authorization
-- bugs are born.
CREATE TABLE user_departments (
  user_id       uuid        NOT NULL,
  department_id uuid        NOT NULL,
  company_id    uuid        NOT NULL,
  -- Defaults only: which department a new job lands under. Never an access
  -- decision — access considers all of a user's departments.
  is_primary    boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, department_id),

  -- These composite FKs are a security control, not pedantry. A plain FK
  -- would permit attaching a user to another tenant's department. That join
  -- row lives legitimately in your own tenant, so RLS would not catch it —
  -- a leak with no detection surface. The composite form makes it
  -- structurally impossible (BR-008).
  CONSTRAINT fk_user_departments_user
    FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_user_departments_department
    FOREIGN KEY (department_id, company_id) REFERENCES departments (id, company_id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE UNIQUE INDEX ux_user_departments_primary ON user_departments (user_id) WHERE is_primary;
--> statement-breakpoint
CREATE INDEX ix_user_departments_company_dept ON user_departments (company_id, department_id);
--> statement-breakpoint

GRANT UPDATE, DELETE ON user_departments TO findneo_app;
