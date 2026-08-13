# FindNeo — Data Model: Identity & Access, Forms, Jobs

**Scope:** everything week one builds against. Identity, access control, smart forms, and jobs with pipeline configuration, plus the cross-cutting tables (`outbox`, `audit_logs`, `settings`, `field_visibility_rules`) those modules depend on.

**Out of scope here, covered later:** candidates, applications, interviews, scorecards, agency engagements, commission attribution.

Authority: `00-decisions.md`. Where this document and the uploaded `Database_design_V1.xlsx` differ, the differences are deliberate and listed in §11.

---

## 1. Conventions

| Concern | Rule |
|---|---|
| Primary keys | `uuid` defaulting to `uuidv7()` — native in PG18 (D-032) |
| Timestamps | `timestamptz`, never `timestamp`. `created_at`/`updated_at` on every mutable table |
| Email | `citext` — case-insensitive comparison without `lower()` on every query |
| Money | `numeric(14,2)` with an explicit currency column. Never float |
| Enums | `text` + `CHECK`, not PostgreSQL `ENUM` types — adding a value to a PG enum is a migration that locks, and on-premise upgrades skip versions (ER-032) |
| Tenant column | `company_id` on every tenant-scoped table, always the leading index column |
| Deletion | Personal data is anonymized, never deleted (D-034). Configuration is soft-deleted via `status` |
| Naming | `snake_case` tables and columns, plural table names, `fk_`/`ix_`/`ux_`/`ck_`/`trg_` prefixes |

**Extensions required:** `citext`. Nothing else — `uuidv7()` and `gen_random_uuid()` are both core in PG18.

---

## 2. Database roles and the RLS pattern

Three PostgreSQL application roles, none of them superuser, none of them the table owner. The table owner is **`findneo_migrator`** — a separate role that runs migrations and never serves traffic. Ratified name; use it everywhere.

| Role | Used by | Grants |
|---|---|---|
| `findneo_app` | API server, worker | Full DML on tenant tables, subject to RLS |
| `findneo_public` | Career site routes (D-026) | `SELECT` on published jobs and their public projections; `INSERT` on applications and attachments. Nothing else |
| `findneo_platform` | Platform-admin operations only | Explicit permissive policies, fully audited |

`findneo_public` is the important one. Its blast radius is bounded by grants rather than by handler correctness — an authorization bug in the only unauthenticated write path cannot reach data the role was never granted.

### Grant defaults are deliberately narrow

`ALTER DEFAULT PRIVILEGES` grants **`SELECT` and `INSERT` only**. `UPDATE` and `DELETE` are granted per-table, in the migration that creates each table.

**Why the inversion:** `audit_logs` must never receive `UPDATE` or `DELETE` (SEC-036), and a blanket default would hand them over, requiring every future audit-like table to remember a revoke. Forgetting an explicit grant is a loud runtime error caught by the first test. Forgetting a revoke is a silent hole nobody notices until it matters.

The same reasoning applies to any table added later whose integrity depends on being append-only.

### The canonical policy

Every tenant-scoped table gets exactly this, unless noted:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON <t>
  AS PERMISSIVE FOR ALL TO findneo_app
  USING      (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.current_company_id', true), '')::uuid);
```

**The `nullif` is not optional.** A transaction-local GUC does not become undefined when its transaction ends — it reverts to the **empty string**. So `current_setting(…, true)` returns NULL only on a connection that has never bound a tenant, and `''` on every connection that has served one. `''::uuid` raises `invalid input syntax for type uuid` rather than yielding NULL.

Without `nullif`, an untenanted query on a warm pooled connection produces a **500**, not zero rows. It still fails closed — nothing leaks — but it violates SEC-003's requirement that the failure direction be "nothing, never everything", and on a warm pool that is most connections.

This is invisible to any test that uses one connection. The concurrency harness must run **more transactions than the pool has connections**, so bound connections are demonstrably reused.

`FORCE` matters separately: without it the owning role bypasses every policy.

### The migrator and FORCE

`findneo_migrator` owns every table. Under `FORCE`, an owner is subject to policies too — and no policy names the migrator, so it is denied on tables it owns. Migration 015 (seeding the permission catalog, default roles, and default templates) would fail exactly there.

**Resolution:**

```sql
ALTER ROLE findneo_migrator WITH BYPASSRLS;
```

**Why this is not a weakening.** The migrator owns the tables, so it can already `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` at will. Withholding `BYPASSRLS` grants nothing it cannot grant itself; it only costs a per-table migrator policy that someone will eventually forget to write. The control that actually matters is that **migrator credentials never reach a serving process** — `DATABASE_URL_MIGRATOR` exists solely for the migration step and the application config loader deliberately does not read it.

**Compensating assertions, required in the isolation suite:**
- `findneo_app` and `findneo_public` do **not** have `BYPASSRLS` — asserted against `pg_roles`, not assumed.
- Every table carrying `company_id` has RLS **enabled and forced** (unchanged).
- The application and worker configuration schemas have no field capable of holding the migrator connection string.

Context is bound once per request, parameterised, inside the transaction (ER-018):

```sql
SELECT set_config('app.current_company_id', $1, true);
```

**Platform staff rows have `company_id IS NULL` and therefore satisfy no tenant policy** — NULL comparison yields NULL, which fails. Tenant isolation from platform accounts is automatic rather than conditional (D-005).

**Migration ordering note:** migration 013 enables RLS; migration 015 seeds. Seeding runs as `findneo_migrator`, which is why the `BYPASSRLS` grant above must be part of migration 001, not deferred.

---

## 3. Platform & identity

### `companies`

The single tenant entity. Organisations and agencies are the same table, distinguished by a bitwise capability flag (D-035).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `uuidv7()` |
| `name` | text | not null |
| `slug` | text | not null, globally unique — career site addressing |
| `company_type` | smallint | not null. Bitwise: 1 = organisation, 2 = agency, 3 = both. Future types take 4, 8 with no schema change |
| `status` | text | not null default `'pending_verification'` → `active` / `suspended` |
| `plan_tier` | text | not null default `'trial'`. Inert in v1; billing is Phase 2 (O-007) |
| `owner_user_id` | uuid | nullable FK → `users.id`. The founding Super Admin |
| `country_code` | char(2) | not null — drives default currency and future data-residency routing |
| `created_at` / `updated_at` | timestamptz | |

```sql
CONSTRAINT ck_companies_type CHECK (company_type BETWEEN 1 AND 3)
CONSTRAINT ck_companies_slug CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
UNIQUE (slug)
```

**RLS:** `id = current_setting('app.current_company_id', true)::uuid`. Note the column is `id`, not `company_id` — this is the one table where the tenant key is the primary key.

**Circular FK:** `companies.owner_user_id` → `users.id` while `users.company_id` → `companies.id`. Resolved by leaving `owner_user_id` nullable and setting it in the same transaction as signup, after the first user row exists. Do not make this deferrable; nullable is simpler and the invariant is enforced in the signup service.

**`slug` is globally unique, not tenant-scoped** — it addresses the public career site, so it cannot be per-tenant. Reserved slugs (`www`, `api`, `app`, `admin`, `static`) are rejected at signup.

---

### `users`

Global identity for internal actors: HR, hiring managers, interviewers, coordinators, agency staff, and platform staff. **Candidates are never in this table** (D-015).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | FK → `companies.id`. **NULL only for platform staff** (D-005) |
| `email` | citext | not null |
| `password_hash` | text | NULL when `auth_provider <> 'password'`. argon2id |
| `full_name` | text | not null |
| `phone` | text | |
| `status` | text | not null default `'pending'` → `active` / `suspended` / `deactivated` |
| `email_verified_at` | timestamptz | |
| `mfa_enabled` | boolean | not null default false |
| `mfa_secret_encrypted` | text | |
| `auth_provider` | text | not null default `'password'`. SSO is post-v1 |
| `provider_subject_id` | text | |
| `last_login_at` | timestamptz | |
| `failed_login_count` | smallint | not null default 0 |
| `locked_until` | timestamptz | |
| `anonymized_at` | timestamptz | D-034 seam |
| `created_at` / `updated_at` | timestamptz | |

```sql
-- Email is globally unique across ALL users, tenant and platform alike (D-049).
CREATE UNIQUE INDEX ux_users_email ON users (email)
  WHERE anonymized_at IS NULL;
CONSTRAINT ux_users_id_company UNIQUE (id, company_id)   -- composite FK target
CREATE INDEX ix_users_company_created ON users (company_id, created_at DESC);
```

`ux_users_id_company` looks redundant against the primary key. It is not — it is the target every composite tenant-safe FK in §4 points at, and without it those FKs cannot be declared.

**Email is globally unique, not tenant-scoped** (D-049). Login is email-first at one fixed domain (D-006), so a tenant-scoped index would make the lookup ambiguous — the same address in two companies gives two candidate users and no way to choose without asking for a company, which D-006's superseded table already rejected.

This also resolves O-011: a platform-staff address cannot collide with a tenant user's.

**Accepted limitation:** one person cannot hold accounts at two companies under the same address. Given BR-005 (a user belongs to exactly one company), that is already close to the intended model. If it becomes a real constraint, the upgrade path is a second login step that disambiguates **after** password verification — never before, since listing an address's companies pre-authentication is an enumeration oracle.

**Brute-force lockout is inline** (`failed_login_count`, `locked_until`). There is no `login_attempts` table; it never existed despite appearing in prior handoff documents.

**Trigger `trg_owner_requires_mfa`:** blocks assigning the Super Admin role to a user with `mfa_enabled = false` (D-006). Enforced in the database because it is a security invariant, not a workflow preference.

---

### `sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | FK → `users.id`, not null, cascade |
| `company_id` | uuid | Denormalized for RLS. NULL for platform staff |
| `active_capability` | smallint | not null default 1. 1 = organisation view, 2 = agency view |
| `family_id` | uuid | not null — refresh token family, for reuse detection |
| `refresh_token_hash` | text | not null, unique |
| `rotated_from_id` | uuid | nullable self-FK — rotation chain |
| `device_info` | text | |
| `ip_address` | inet | |
| `issued_at` / `expires_at` | timestamptz | not null |
| `revoked_at` | timestamptz | |

```sql
CREATE INDEX ix_sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ix_sessions_family ON sessions (family_id);
```

**Correction against the uploaded sheet:** the sheet defines `active_company_id` as *the client company* for an agency user. That is removed. Under D-014 a session is always scoped to the user's own company; access to a client's data flows through `agency_engagements` joins with their own policies, never by rebinding tenant context. `company_id` here always equals `users.company_id`.

**Reuse detection:** presenting a refresh token that has already been rotated revokes the entire `family_id`. This is the standard defence against stolen refresh tokens and it needs the family column from day one.

---

### `departments`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | FK → `companies.id`, not null, cascade |
| `name` | text | not null |
| `head_user_id` | uuid | FK → `users.id`, nullable |
| `status` | text | not null default `'active'` |
| `created_at` | timestamptz | |

```sql
UNIQUE (company_id, name)
CONSTRAINT ux_departments_id_company UNIQUE (id, company_id)   -- composite FK target
```

Flat, single level. Hierarchy is not in v1 and no `parent_id` is reserved — unlike D-028b's department column, a hierarchy is a genuine redesign of every scope query, so reserving a column would not actually make it cheap.

---

### `user_departments`

Membership only. **No `role_id`** (D-007).

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | PK part |
| `department_id` | uuid | PK part |
| `company_id` | uuid | not null — participates in both composite FKs |
| `is_primary` | boolean | not null default false |
| `created_at` | timestamptz | |

```sql
PRIMARY KEY (user_id, department_id)
FOREIGN KEY (user_id, company_id)       REFERENCES users (id, company_id) ON DELETE CASCADE
FOREIGN KEY (department_id, company_id) REFERENCES departments (id, company_id) ON DELETE CASCADE
CREATE UNIQUE INDEX ux_user_departments_primary ON user_departments (user_id) WHERE is_primary;
CREATE INDEX ix_user_departments_company_dept ON user_departments (company_id, department_id);
```

**The composite FKs are a security control, not pedantry.** Plain FKs would permit attaching a user to another tenant's department. That join row lives legitimately in your own tenant, so RLS would not catch it — it is a leak with no detection surface. The composite form makes it structurally impossible.

**`is_primary` is for defaults only** — which department a new job lands under. Never an access decision. Access considers all of a user's departments.

---

## 4. Access control

### `permissions`

Fixed platform-wide catalog. Companies compose these into custom roles; they cannot invent permission types (that would require a plugin architecture nobody has scoped).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `key` | text | unique, not null — `jobs.create` |
| `category` | text | not null — grouping for the role editor UI |
| `description` | text | |

No `company_id`. No RLS — this table is global reference data, readable by all.

### `roles`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | FK → `companies.id`. **NULL = platform default role** |
| `key` | text | not null |
| `name` | text | not null |
| `scope` | text | not null — `platform` / `company` / `department` / `job` |
| `is_editable` | boolean | not null default true. false for platform defaults |
| `created_at` | timestamptz | |

```sql
CREATE UNIQUE INDEX ux_roles_platform_key ON roles (key) WHERE company_id IS NULL;
CREATE UNIQUE INDEX ux_roles_company_key  ON roles (company_id, key) WHERE company_id IS NOT NULL;
CONSTRAINT ck_roles_scope CHECK (scope IN ('platform','company','department','job'))
```

`department` was added to `scope` per D-007. **RLS:** `company_id = current_setting(...)::uuid OR company_id IS NULL` — companies must read platform defaults. This is a deliberate, documented deviation from the canonical policy; write policies remain strictly tenant-scoped so a company can never modify a platform default.

Platform defaults and company custom roles are **additive** when both apply to a person — union of permissions, not override.

### `role_permissions`

`(role_id, permission_id)` composite PK, both cascade. No RLS — reachable only through `roles`, which is already protected.

### `user_roles`

The role assignment mechanism (D-007). Supersedes `user_departments.role_id`, `organization_memberships`, and `membership_roles`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Surrogate, not composite |
| `company_id` | uuid | not null |
| `user_id` | uuid | not null |
| `role_id` | uuid | FK → `roles.id`, not null |
| `department_id` | uuid | **nullable** — NULL = company-wide |
| `granted_by` | uuid | FK → `users.id` |
| `created_at` | timestamptz | |

```sql
FOREIGN KEY (user_id, company_id)       REFERENCES users (id, company_id) ON DELETE CASCADE
FOREIGN KEY (department_id, company_id) REFERENCES departments (id, company_id) ON DELETE CASCADE

CREATE UNIQUE INDEX ux_user_roles_company_wide ON user_roles (user_id, role_id)
  WHERE department_id IS NULL;
CREATE UNIQUE INDEX ux_user_roles_scoped ON user_roles (user_id, role_id, department_id)
  WHERE department_id IS NOT NULL;

CREATE INDEX ix_user_roles_lookup ON user_roles (company_id, user_id);
```

**Why a surrogate PK with partial unique indexes** rather than a composite PK: a composite PK over a nullable column does not work in PostgreSQL — NULLs are not equal to each other, so `(user, role, NULL)` could be inserted repeatedly. The two partial indexes express the real rule: one company-wide grant per role, and one grant per role per department.

**No `job_id` column.** Job-level assignment lives exclusively in `job_hiring_team` (D-008). Two systems answering "who works on this job" is how authorization bugs are born.

### `invitations`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null, cascade |
| `email` | citext | not null |
| `role_id` | uuid | FK → `roles.id`, not null |
| `department_id` | uuid | nullable |
| `invited_by` | uuid | FK → `users.id`, not null |
| `token_hash` | text | not null, unique — **hashed, never raw** (ER-047) |
| `status` | text | not null default `'pending'` → `accepted` / `expired` / `revoked` |
| `expires_at` | timestamptz | not null |
| `accepted_at` | timestamptz | |
| `created_at` | timestamptz | |

```sql
CREATE INDEX ix_invitations_company_status ON invitations (company_id, status);
CREATE UNIQUE INDEX ux_invitations_pending_email ON invitations (company_id, email)
  WHERE status = 'pending';
```

The partial unique index prevents invitation spam to the same address.

---

## 5. Smart forms (D-028)

Three tables. Fields hang off a **version**, not a template — that is what freezes historical rendering.

### `form_templates`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | **NULL = platform default template** |
| `entity_type` | text | not null — `job` / `application` |
| `department_id` | uuid | **nullable, always NULL in v1** — reserved for D-028b |
| `name` | text | not null |
| `status` | text | not null default `'active'` |
| `created_by` | uuid | FK → `users.id` |
| `created_at` / `updated_at` | timestamptz | |

```sql
CONSTRAINT ck_form_templates_entity CHECK (entity_type IN ('job','application'))
CREATE UNIQUE INDEX ux_form_templates_platform ON form_templates (entity_type)
  WHERE company_id IS NULL;
CREATE UNIQUE INDEX ux_form_templates_company ON form_templates (company_id, entity_type)
  WHERE company_id IS NOT NULL AND department_id IS NULL;
```

`department_id` is deliberately inert (D-028b). Documented so nobody removes it as dead schema.

### `form_template_versions`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `template_id` | uuid | FK, not null, cascade |
| `company_id` | uuid | nullable, denormalized for RLS |
| `version_no` | integer | not null |
| `status` | text | not null default `'draft'` → `published` / `archived` |
| `published_at` | timestamptz | |
| `published_by` | uuid | FK → `users.id` |
| `created_at` | timestamptz | |

```sql
UNIQUE (template_id, version_no)
CREATE UNIQUE INDEX ux_form_versions_published ON form_template_versions (template_id)
  WHERE status = 'published';
```

One published version at a time. Publishing a new version archives the previous one; **existing records keep pointing at the version they were created under.**

### `form_template_fields`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `version_id` | uuid | FK, not null, cascade |
| `company_id` | uuid | nullable, denormalized for RLS |
| `key` | text | not null — the JSON key inside `custom_fields` |
| `label` | text | not null |
| `help_text` | text | |
| `data_type` | text | not null — `text` / `long_text` / `number` / `date` / `boolean` / `select` / `multi_select` |
| `is_required` | boolean | not null default false |
| `options` | jsonb | not null default `'[]'` — for select types |
| `max_length` | integer | text types only |
| `min_value` / `max_value` | numeric | number types only |
| `section` | text | grouping label |
| `sequence_order` | smallint | not null |
| `visibility_rule` | jsonb | **nullable, unread in v1** — reserved for D-028a |
| `created_at` | timestamptz | |

```sql
UNIQUE (version_id, key)
CONSTRAINT ck_field_key CHECK (key ~ '^[a-z][a-z0-9_]{0,48}$')
CONSTRAINT ck_field_type CHECK (data_type IN
  ('text','long_text','number','date','boolean','select','multi_select'))
```

### Enforced caps

At publish time, not at render time:

| Cap | Value | Reason |
|---|---|---|
| Fields per version | 60 | |
| Text value length | 2,000 chars | |
| Total `custom_fields` payload | 32 KB | |
| Options per select field | 100 | |

The application form is filled through the **unauthenticated** career site. Without these caps a customer can configure a form that becomes a denial-of-service vector against their own public endpoint (D-028).

### Resolution and validation

**Active template for `(company_id, entity_type)`:** company published version, else platform default. The department branch exists in the resolution function but is unreachable in v1.

**Validation:** field definitions compile to a JSON Schema, cached per version (`CachePort`, tenant-keyed per ER-024), validated by the same Ajv instance Fastify uses for static routes. Version id is part of the cache key, so publishing invalidates naturally rather than needing explicit eviction.

**Storage:** values in `jobs.custom_fields jsonb` and later `applications.custom_fields jsonb`, each with a GIN index. Not EAV — an EAV value table turns every list query into a self-join per field.

---

## 6. Jobs & pipeline

### `jobs`

Typed columns are everything the system reasons about (D-028): permissions, pipeline, masking, and the Resume Ranker's inputs.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | FK, not null |
| `department_id` | uuid | FK, not null |
| `title` | text | not null |
| `description` | text | |
| `status` | text | not null default `'draft'` — `draft` / `open` / `on_hold` / `closed` |
| `confidential` | boolean | not null default false — skips department visibility entirely |
| `employment_type` | text | `full_time` / `part_time` / `contract` / `internship` / `temporary` |
| `work_mode` | text | `onsite` / `hybrid` / `remote` |
| `country_code` | char(2) | |
| `city` | text | |
| `location_text` | text | free display form |
| `headcount` | smallint | not null default 1 |
| `salary_min` / `salary_max` | numeric(14,2) | **masked fields** — see `field_visibility_rules` |
| `salary_currency` | char(3) | ISO 4217 |
| `salary_period` | text | `annual` / `monthly` / `hourly` |
| `experience_min_years` / `experience_max_years` | numeric(4,1) | |
| `education_level` | text | |
| `target_start_date` | date | |
| `closes_at` | timestamptz | |
| `publish_to_career_site` | boolean | not null default true |
| `published_at` | timestamptz | |
| `form_template_version_id` | uuid | FK, not null — the version this job was created under |
| `custom_fields` | jsonb | not null default `'{}'` |
| `created_by` | uuid | FK → `users.id`, not null |
| `created_at` / `updated_at` | timestamptz | |

```sql
FOREIGN KEY (department_id, company_id) REFERENCES departments (id, company_id)
CONSTRAINT ck_jobs_salary CHECK (salary_max IS NULL OR salary_min IS NULL OR salary_max >= salary_min)
CONSTRAINT ck_jobs_headcount CHECK (headcount > 0)

CREATE INDEX ix_jobs_company_status  ON jobs (company_id, status, created_at DESC);
CREATE INDEX ix_jobs_company_dept    ON jobs (company_id, department_id) WHERE status <> 'closed';
CREATE INDEX ix_jobs_custom_fields   ON jobs USING gin (custom_fields);
CREATE INDEX ix_jobs_public          ON jobs (company_id, published_at DESC)
  WHERE status = 'open' AND publish_to_career_site AND NOT confidential;
```

### Confidential jobs — enforcement

There is **no CHECK constraint** coupling `confidential` and `publish_to_career_site`. A CHECK would make "mark this already-published job confidential" fail with a constraint violation, when the correct behaviour is for it to succeed and withdraw the job from the public site.

Instead the two flags stay independent, and exposure is prevented at the role boundary:

```sql
CREATE POLICY public_jobs_readable ON jobs
  AS PERMISSIVE FOR SELECT TO findneo_public
  USING (
    status = 'open'
    AND publish_to_career_site
    AND NOT confidential
    AND company_id = current_setting('app.public_company_id', true)::uuid
  );
```

`findneo_public` has `SELECT` on `jobs` and no other grant in this module. The predicate lives in the policy, not in the query, so **every** current and future public read path inherits it — the career site, a JSON feed, a sitemap, an embeddable widget, job-board distribution. A developer adding a public endpoint cannot forget the filter, because there is no filter to write.

This is the general pattern for the public surface: the API filters as normal (ER-020), and the role's policy is the floor underneath it. `ix_jobs_public` matches the policy predicate exactly, so the policy costs nothing at runtime.

**Transition behaviour, handled in the service, in-transaction:** setting `confidential = true` also sets `publish_to_career_site = false` and clears `published_at`. The action is audited as an unpublish. Un-setting `confidential` does *not* automatically republish — reappearing on a public site is never a side effect of a private-flag change.

**Not present, deliberately:** `pipeline_template_id` (stale, unused — removed). Approval chains (Phase 2, D-030). External job board distribution (Phase 2).

### `skills`

Company-scoped catalog with platform-seeded common skills.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | NULL = platform-seeded |
| `name` | text | not null |
| `slug` | text | not null — normalized for matching |
| `created_at` | timestamptz | |

```sql
CREATE UNIQUE INDEX ux_skills_platform ON skills (slug) WHERE company_id IS NULL;
CREATE UNIQUE INDEX ux_skills_company  ON skills (company_id, slug) WHERE company_id IS NOT NULL;
```

A normalized catalog rather than free text on `job_skills`, because the Resume Ranker matches against these and free text makes "React" / "ReactJS" / "react.js" three different skills. Unknown skills are auto-created in the company's scope on first use.

### `job_skills`

The ranker's structured input (D-029).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `job_id` | uuid | FK, not null, cascade |
| `skill_id` | uuid | FK → `skills.id`, not null |
| `min_years` | numeric(4,1) | |
| `is_mandatory` | boolean | not null default false |
| `weight` | smallint | not null default 5 |
| `sequence_order` | smallint | |

```sql
UNIQUE (job_id, skill_id)
CONSTRAINT ck_job_skills_weight CHECK (weight BETWEEN 1 AND 10)
```

### `job_hiring_team`

Sole source of job-level assignment (D-008).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `job_id` | uuid | FK, not null, cascade |
| `user_id` | uuid | FK, not null |
| `team_role` | text | `hiring_manager` / `recruiter` / `coordinator` / `interviewer` |
| `added_by` | uuid | FK → `users.id` |
| `added_at` | timestamptz | |

```sql
UNIQUE (job_id, user_id, team_role)
FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id)
CREATE INDEX ix_hiring_team_user ON job_hiring_team (company_id, user_id);
```

`ix_hiring_team_user` serves the hot path — "which jobs can this user see," evaluated on nearly every list request.

`coordinator` is included in `team_role` because the PRD and RBAC matrix both define a Coordinator actor that `product_spec_v1.md` omitted.

### `pipeline_templates` / `pipeline_template_stages`

Reusable named blueprints.

`pipeline_templates`: `id`, `company_id` (NULL = platform default), `name`, `status`, `created_by`, `created_at`. Unique `(company_id, name)`.

`pipeline_template_stages`: `id`, `template_id` (cascade), `company_id`, `name`, `sequence_order`, `stage_type`, `is_terminal`. Unique `(template_id, sequence_order)`.

### `job_pipeline_stages`

A **one-time copy** taken at job creation, permanently independent of the template afterwards. Editing a template never alters a live job's pipeline.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `job_id` | uuid | FK, not null, cascade |
| `name` | text | not null |
| `sequence_order` | smallint | not null |
| `stage_type` | text | `applied` / `screening` / `interview` / `offer` / `hired` / `rejected` |
| `is_terminal` | boolean | not null default false |

```sql
UNIQUE (job_id, sequence_order)
CONSTRAINT ck_stage_type CHECK (stage_type IN
  ('applied','screening','interview','offer','hired','rejected'))
```

**Reordering:** `sequence_order` is unique per job, so a naive reorder violates the constraint mid-update. Reorder within a transaction using a two-phase shift, or declare the constraint `DEFERRABLE INITIALLY IMMEDIATE` and defer it for the reorder transaction. Pick one and use it consistently — this is a real source of intermittent bugs.

---

## 7. Cross-cutting

### `settings`

Key/value company configuration, `company_id IS NULL` = platform default.

Columns: `id`, `company_id`, `key`, `value jsonb`, `updated_by`, `updated_at`. Unique on `(key) WHERE company_id IS NULL` and `(company_id, key)` otherwise.

**Registry for v1** — keys are a documented enumeration, not freeform:

| Key | Default | Range |
|---|---|---|
| `candidate.multi_role_mode` | `restrict` | `restrict` / `allow` |
| `candidate.max_active_applications` | `1` | 1–10 |
| `agency.default_cool_off_months` | `6` | 1–24 |
| `job.default_pipeline_template_id` | platform default | |
| `security.session_idle_timeout_minutes` | `480` | |

Only genuinely tunable config belongs here. Structured data that deserves typed columns must not be hidden in `value` — that is how a schema becomes unqueryable.

### `field_visibility_rules`

Maps `(company_id, table_name, field_name) → required_permission_id`. Company rule beats platform default via `ORDER BY company_id NULLS LAST LIMIT 1`. **No row means unmasked.**

Columns: `id`, `company_id` (NULL = platform default), `table_name`, `field_name`, `required_permission_id`, `created_at`. Unique `(company_id, table_name, field_name)`.

Masking is applied at serialization, after row access resolves (D-025). PostgreSQL RLS cannot mask individual columns, so this is necessarily an application-layer concern — which makes ER-025's allowlist serialization the enforcement point.

**Audit entries obey these rules too.** Otherwise the audit trail becomes a bypass of the exact control it exists to enforce.

### `outbox`

Transactional outbox (D-031).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | nullable |
| `event_type` | text | not null — `job.published` |
| `event_version` | smallint | not null default 1 |
| `aggregate_type` / `aggregate_id` | text / uuid | not null |
| `payload` | jsonb | not null — **ids and metadata only, never personal data** (ER-048) |
| `occurred_at` | timestamptz | not null |
| `published_at` | timestamptz | |
| `attempts` | smallint | not null default 0 |
| `last_error` | text | |

```sql
CREATE INDEX ix_outbox_unpublished ON outbox (occurred_at) WHERE published_at IS NULL;
```

The partial index stays small regardless of table size — it only ever contains the backlog.

### `idempotency_keys`

Backs the idempotency contract in `07-api-standards.md` §9. Required on every side-effecting POST (ER-040).

**Created in migration 001b, during Phase 0**, not with the migration 009 group. It has no foreign keys and depends on no other table, and the middleware that uses it (T-010) ships in Phase 0 — untested middleware in production is a worse trade than an out-of-sequence migration number.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | **nullable** — NULL for pre-tenant routes such as signup |
| `key` | text | not null — client-supplied |
| `endpoint` | text | not null — scopes the key so one key cannot be reused across routes |
| `request_hash` | text | not null — SHA-256 of the canonicalised body |
| `status` | text | not null default `'in_flight'` → `completed` |
| `response_status` | smallint | |
| `response_body` | jsonb | |
| `created_at` | timestamptz | not null |
| `expires_at` | timestamptz | not null — 24 hours |

```sql
CREATE UNIQUE INDEX ux_idem_scope ON idempotency_keys (company_id, endpoint, key);
CREATE INDEX ix_idem_expiry ON idempotency_keys (expires_at);
```

**`in_flight` is the load-bearing state.** The row is inserted *before* the handler runs. A concurrent request carrying the same key hits the unique index, sees `in_flight`, and returns 409 with `Retry-After` — rather than both requests executing. Without this the idempotency layer only protects sequential retries, which is the easy half of the problem.

**`company_id` is nullable and RLS is therefore non-standard here:** the policy permits `company_id = current_setting(...)::uuid OR company_id IS NULL`, and pre-tenant rows are additionally scoped by `endpoint`. Signup and password reset need idempotency before a tenant exists.

Expired rows are reaped by a `system` domain job. This table grows quickly and is the one place a missed cleanup job shows up as disk pressure.

### `audit_logs`

Compliance-grade field-level diffs. Distinct from `activity_logs`, which holds pre-rendered user-facing summaries.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid | not null |
| `actor_user_id` | uuid | nullable — NULL for system actions |
| `actor_role_key` | text | role in effect at the time |
| `action` | text | not null |
| `entity_type` / `entity_id` | text / uuid | not null |
| `changes` | jsonb | `{ field: { old, new } }` |
| `ip_address` | inet | |
| `trace_id` | text | |
| `created_at` | timestamptz | not null |

Partitioned monthly by `created_at` from the first migration — converting a large unpartitioned audit table later is a painful outage. Append-only: `findneo_app` gets `INSERT` and `SELECT`, never `UPDATE` or `DELETE`.

### `activity_logs`

`id`, `company_id`, `actor_user_id`, `entity_type`, `entity_id`, `summary`, `metadata jsonb`, `created_at`. Index `(company_id, entity_type, entity_id, created_at DESC)`.

---

## 8. Migration order

Foreign key dependencies force this sequence:

```
001  extensions (citext, pg_trgm), database roles, grants
001b idempotency_keys        ← Phase 0. No foreign keys, depends on nothing
002  companies                      (owner_user_id FK added in 004)
003  users, sessions
004  ALTER companies ADD FK owner_user_id
005  departments, user_departments
006  permissions, roles, role_permissions, user_roles
007  invitations
008  settings, field_visibility_rules
009  outbox, audit_logs (partitioned), activity_logs
010  form_templates, form_template_versions, form_template_fields
011  skills, pipeline_templates, pipeline_template_stages
012  jobs, job_skills, job_hiring_team, job_pipeline_stages
013  RLS: enable, force, policies on every table above
014  triggers: trg_owner_requires_mfa, updated_at maintenance
015  seed: permissions, default roles, default pipeline template, default form templates
```

**Migration 013 is deliberately last and deliberately separate.** RLS enablement is the single change most likely to be partially applied, and having every policy in one reviewable migration makes it auditable. Its accompanying test asserts that *every* table carrying a `company_id` column has RLS enabled and forced — a schema-level guard against someone adding a table later and forgetting.

---

## 9. Seed data

**Permission catalog** — the authoritative list is `04-permissions.md` §2 (76 keys). Grouped here by category for orientation only; where the two differ, `04` wins:

| Category | Keys |
|---|---|
| Company | `company.read`, `company.update`, `company.settings.manage` |
| Users | `users.read`, `users.invite`, `users.update`, `users.deactivate` |
| Roles | `roles.read`, `roles.create`, `roles.update`, `roles.delete`, `roles.assign` |
| Departments | `departments.read`, `departments.create`, `departments.update`, `departments.delete` |
| Jobs | `jobs.read`, `jobs.read.all`, `jobs.create`, `jobs.update`, `jobs.publish`, `jobs.close`, `jobs.delete`, `jobs.confidential.read` |
| Hiring team | `jobs.team.read`, `jobs.team.manage` |
| Pipeline | `pipeline.read`, `pipeline.configure`, `pipeline.templates.manage` |
| Forms | `forms.read`, `forms.configure` |
| Compensation | `jobs.salary.read`, `candidates.compensation.read` |
| Audit | `audit.read` |
| Agencies | `agencies.read`, `agencies.invite`, `agencies.manage` |

`jobs.read` vs `jobs.read.all` is the department-scope distinction: the former sees your departments and your hiring-team jobs, the latter sees everything in the company. `jobs.confidential.read` is separate again — confidential jobs are visible only to their hiring team regardless of either.

**Default roles** — eight, per `04-permissions.md` §3's matrix (`company_id IS NULL`, `is_editable = false`). An earlier draft of this section listed seven and omitted `recruiter`; `04` is authoritative:

| Role | Scope | Shape |
|---|---|---|
| `system_admin` | platform | Internal FindNeo staff. No tenant data without audited impersonation |
| `super_admin` | company | Tenant owner. Full company access, MFA mandatory |
| `org_admin_hr` | company | Jobs, pipelines, users, agencies, compensation visible |
| `hiring_manager` | department | Own requisitions and pipeline. Blind outside their departments |
| `recruiter` | company | Sources and progresses candidates across assigned jobs |
| `coordinator` | company | Scheduling and logistics. **No** compensation, **no** feedback scores |
| `interviewer` | job | Assigned interviews and own feedback only |
| `agency_recruiter` | company | Agency portal only. Never sees internal communication or scorecards |

**Default `field_visibility_rules`:** `jobs.salary_min`, `jobs.salary_max` → `jobs.salary.read`. Application and feedback fields are added with their modules.

**Default form templates:** one generic `job` template and one generic `application` template, both `company_id IS NULL`, both published at version 1. A company that never configures anything uses these permanently.

**Default pipeline template:** Applied → Screening → Interview → Offer → Hired, plus a terminal Rejected stage.

---

## 10. Test requirements for this slice

Beyond ER-054's per-feature leak test, these are specifically required here:

1. Unset `app.current_company_id` returns **zero rows** from every tenant table, not all rows.
2. A platform-staff row (`company_id IS NULL`) is invisible to every tenant context.
3. A composite FK rejects attaching a user to another tenant's department.
4. `findneo_public` cannot read a confidential job, an unpublished job, or any user row — asserted with a **raw, unfiltered** `SELECT * FROM jobs` under that role, so the test proves the policy holds and not the query.
4a. Marking a published job confidential succeeds, withdraws it from public reads, and is audited as an unpublish. Un-setting confidential does not republish it.
5. Assigning `super_admin` to a user without MFA is rejected by the database.
6. A rotated refresh token, when replayed, revokes the whole family.
7. Publishing form template version 2 leaves jobs created under version 1 rendering with version 1's fields.
8. A custom field payload exceeding 32 KB is rejected at the API edge, not at the database.
9. Every table with a `company_id` column has RLS enabled and forced (schema-level assertion).

---

## 11. Corrections applied against `Database_design_V1.xlsx`

| # | Sheet says | Corrected to | Reason |
|---|---|---|---|
| 1 | `user_departments.role_id`, marked PK while PK is `(user_id, department_id)` | `role_id` removed; roles via `user_roles` | D-007. The sheet was also internally inconsistent |
| 2 | `sessions.active_company_id` = client company for agency users | Always the user's own company | D-014 — the sheet's version is a tenant-isolation hole |
| 3 | `commission_attributions.attributed_agency_id → agencies.id` | → `companies.id` | `agencies` no longer exists post-merge |
| 4 | `trg_focus_attribute_job_match` | `trg_focus_attribute_stage_match` | Name contradicted the logic |
| 5 | `org_candidate_pool` + `agency_candidate_pool` | One `talent_pool_entries` | D-010 |
| 6 | `applications.resume_url` | Removed | D-011 — third representation of one fact |
| 7 | `stage_decisions.decision_reason_id` — bare row, no type, no target | `decision_reasons` + `stage_decision_reasons` | Incomplete in the sheet |
| 8 | `UNIQUE(job_id, candidate_id)` on applications | Scoped to active status only | D-012 — blocked re-application forever |
| 9 | Partial unique index for one active application | Trigger with row lock | D-012 — a unique index cannot express "at most N" |
| 10 | `jobs` has no salary, headcount, country, experience, or skills | Added as typed columns + `job_skills` | PRD's own job form requires them; ranker consumes skills |
| 11 | `pipeline_templates` referenced but absent | Defined | Missing parent table |
| 12 | `candidate_resumes.application_id NOT NULL` | Nullable — profile-level rows have no application | D-011 |

---

## 12. Forward references

Defined in later documents, referenced here so the FK direction is not re-litigated:

- `applications.form_template_version_id` and `applications.custom_fields` — mirrors the jobs pattern exactly (D-028).
- `agency_engagements` — self-referential `companies` → `companies`. Owns `cool_off_months`. `job_agency_assignments` points at `engagement_id`, never `agency_id`, so a grant cannot exist without the engagement authorising it.
- `ranking_runs` / `application_rankings` — shape depends on the outstanding resume-ranker contract (O-001).
- `decision_reasons` / `stage_decision_reasons` — company-configurable catalog covering both reject and hire decisions.
