# FindNeo — LLD: Jobs, Forms & Pipeline

Modules: `src/modules/jobs/`, `src/modules/forms/`
Phase: 2 · Migrations: 010–012 · Spec basis: `06-data-model.md` §5–6, `04-permissions.md` §4, `00-decisions.md` D-028

**Depends on Phase 1.** Row scope here is the first real exercise of the authorization pipeline, and the pattern established in `jobs.repository.ts` is copied by every later module — get it right once.

---

## 1. Files

```
src/modules/forms/
  forms.routes.ts
  forms.controller.ts
  forms.service.ts            resolution, publish, version freeze
  forms.repository.ts
  form-schema.compiler.ts     field definitions → JSON Schema
  forms.schemas.ts
  forms.mapper.ts
  __tests__/

src/modules/jobs/
  jobs.routes.ts
  jobs.controller.ts
  pipeline.controller.ts
  hiring-team.controller.ts
  jobs.service.ts
  pipeline.service.ts
  hiring-team.service.ts
  skills.service.ts
  jobs.repository.ts          ← the row-scope query lives here
  pipeline.repository.ts
  jobs.schemas.ts
  jobs.mapper.ts
  jobs.errors.ts
  jobs.events.ts
  __tests__/
```

---

## 2. Endpoints

### Forms

| Method | Path | Permission |
|---|---|---|
| GET | `/v1/form-templates` | `forms.read` |
| GET | `/v1/form-templates/{entityType}/active` | `forms.read` |
| POST | `/v1/form-templates` | `forms.configure` |
| POST | `/v1/form-templates/{id}/versions` | `forms.configure` |
| GET | `/v1/form-templates/{id}/versions/{versionId}` | `forms.read` |
| PATCH | `/v1/form-templates/{id}/versions/{versionId}` | `forms.configure` — draft only |
| POST | `/v1/form-templates/{id}/versions/{versionId}/actions/publish` | `forms.configure` |

`GET /v1/form-templates/{entityType}/active` is the contract the frontend renders from. Adding a field requires no frontend release.

### Jobs

| Method | Path | Permission |
|---|---|---|
| GET | `/v1/jobs` | `jobs.read` |
| GET | `/v1/jobs/{id}` | `jobs.read` |
| POST | `/v1/jobs` | `jobs.create` |
| PATCH | `/v1/jobs/{id}` | `jobs.update` |
| DELETE | `/v1/jobs/{id}` | `jobs.delete` — draft only |
| POST | `/v1/jobs/{id}/actions/publish` | `jobs.publish` |
| POST | `/v1/jobs/{id}/actions/close` | `jobs.close` |
| POST | `/v1/jobs/{id}/actions/reopen` | `jobs.publish` |
| POST | `/v1/jobs/{id}/actions/hold` | `jobs.update` |
| POST | `/v1/jobs/{id}/actions/set-confidential` | `jobs.update` |

### Pipeline, team, skills

| Method | Path | Permission |
|---|---|---|
| GET | `/v1/jobs/{id}/stages` | `pipeline.read` |
| POST | `/v1/jobs/{id}/stages` | `pipeline.configure` |
| PATCH | `/v1/jobs/{id}/stages/{stageId}` | `pipeline.configure` |
| DELETE | `/v1/jobs/{id}/stages/{stageId}` | `pipeline.configure` |
| POST | `/v1/jobs/{id}/stages/actions/reorder` | `pipeline.configure` |
| GET/POST/DELETE | `/v1/jobs/{id}/hiring-team[/{userId}]` | `jobs.team.read` / `jobs.team.manage` |
| GET/POST/DELETE | `/v1/jobs/{id}/skills[/{skillId}]` | `jobs.read` / `jobs.update` |
| GET | `/v1/skills` | `jobs.read` |
| GET/POST/PATCH | `/v1/pipeline-templates[/{id}]` | `pipeline.read` / `pipeline.templates.manage` |

**Reorder is a collection action** — the one documented exception to "no actions on collections" in `07-api-standards.md` §2. Reordering is inherently atomic across the set; doing it as N individual PATCHes cannot be made safe.

---

## 3. The row-scope query

This is the pattern every later module copies. It belongs in the repository, in the query — never as a post-fetch filter (SEC-022).

```ts
function jobScopePredicate(ctx: RequestContext) {
  if (ctx.permissions.has('jobs.read.all')) {
    return sql`true`;                       // still inside RLS + explicit company filter
  }
  return sql`(
       (NOT j.confidential AND j.department_id = ANY(${ctx.departmentIds}))
    OR (j.confidential AND ${ctx.permissions.has('jobs.confidential.read')})
    OR EXISTS (
         SELECT 1 FROM job_hiring_team t
          WHERE t.job_id = j.id AND t.user_id = ${ctx.userId}
       )
  )`;
}
```

Composed with the always-present tenant filter:

```sql
WHERE j.company_id = ${ctx.companyId}   -- explicit, on top of RLS (ER-020)
  AND <scopePredicate>
```

**Confidential is not an additional filter — it is a different branch.** Department membership alone must never reveal a confidential job (BR-031). Writing this as `AND (NOT confidential OR hasPermission)` on top of a department check is the mistake to avoid: it lets a department member see a confidential job in their own department.

`ctx.departmentIds` is resolved once per request in the authorization pipeline, not per query.

---

## 4. Key flows

### Job creation

```
POST /v1/jobs
{ title, departmentId, employmentType, workMode, countryCode, city,
  headcount, salaryMin?, salaryMax?, salaryCurrency?,
  experienceMinYears?, educationLevel?, skills?: [...], customFields: {} }
```

1. Resolve the active `job` form template version (company published → platform default).
2. Compile that version's fields to JSON Schema (cached per version id).
3. Validate `customFields` against it → `ERR_VALIDATION_FAILED` with per-field JSON Pointers.
4. BEGIN:
   a. Insert `jobs` with `form_template_version_id` pinned, `status = 'draft'`.
   b. Copy stages from the pipeline template (default from settings, or supplied) into `job_pipeline_stages`.
   c. Insert `job_skills`, auto-creating unknown skills in company scope.
   d. Insert the creator into `job_hiring_team` as `hiring_manager` unless another is named.
   e. Audit entry.
   COMMIT.
5. Return 201.

**Stage copy at step (b) is the point of D-035's template decision.** Editing the template afterwards must never alter this job.

### Publish

Preconditions, checked in the service:
- Status is `draft` or `on_hold`
- At least one stage exists, and at least one terminal stage (BR-034)
- Title, department, and employment type present

Then: set `status = 'open'`, `published_at = now()`, write an outbox event `job.published`, enqueue nothing else in v1. Idempotent — publishing an already-open job returns 200 with no change, not an error.

### Set confidential

The transition that replaced the CHECK constraint (D-026 corollary):

```
POST /v1/jobs/{id}/actions/set-confidential  { confidential: true }
```

BEGIN:
- Set `confidential = true`
- **Also** set `publish_to_career_site = false`, clear `published_at`
- Audit as an unpublish, with reason `confidential`
COMMIT.

`confidential: false` does **not** republish. Reappearing on a public careers page must never be a side effect of clearing a private flag (BR-033).

### Stage reorder

`sequence_order` is unique per job, so a naive update violates the constraint mid-transaction.

```sql
BEGIN;
SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE;         -- serialize concurrent reorders
UPDATE job_pipeline_stages SET sequence_order = sequence_order + 1000
 WHERE job_id = $1;                                   -- phase 1: move out of range
UPDATE job_pipeline_stages SET sequence_order = $n
 WHERE id = $stageId;                                 -- phase 2: assign targets
COMMIT;
```

Pick this two-phase approach and use it consistently. The alternative — a deferrable constraint — also works but must not be mixed with this one; two mechanisms for one problem produce intermittent failures nobody can reproduce.

### Form template publish

1. Version must be `draft`.
2. Validate caps: ≤ 60 fields, ≤ 100 options per select, text `max_length` ≤ 2000 (BR-048).
3. Validate field keys unique and matching `^[a-z][a-z0-9_]{0,48}$`.
4. Compile to JSON Schema — **compilation must succeed before publish**, so an invalid definition can never reach a live form.
5. BEGIN: archive the current published version, mark this one published, audit. COMMIT.
6. Evict the compiled-schema cache for this template.

Existing jobs keep their pinned version. This is the property that makes versioning worth the complexity.

---

## 5. The schema compiler

`form-schema.compiler.ts` — pure function, heavily unit tested.

```ts
function compileFields(fields: FormTemplateField[]): TSchema;
```

| Field type | JSON Schema |
|---|---|
| `text` | `{ type: 'string', maxLength }` |
| `long_text` | `{ type: 'string', maxLength }` |
| `number` | `{ type: 'number', minimum, maximum }` |
| `date` | `{ type: 'string', format: 'date' }` |
| `boolean` | `{ type: 'boolean' }` |
| `select` | `{ type: 'string', enum: [...] }` |
| `multi_select` | `{ type: 'array', items: { enum }, uniqueItems: true }` |

Plus `required: [...]` from `is_required`, and `additionalProperties: false` — a client cannot smuggle an undefined key into `custom_fields`.

Cached in `CachePort` keyed `(companyId, versionId)`. Version id is part of the key, so publishing invalidates naturally.

**`visibility_rule` is read by nothing in v1** (D-028a). The column exists; the compiler ignores it.

---

## 6. Masking

`jobs.salary_min` and `jobs.salary_max` require `jobs.salary.read`. Applied at serialization, and therefore **also in lists, expansions, exports, and the audit history of a salary change** (BR-091).

The audit case is the one that gets missed. A user without `jobs.salary.read` who reads a job's change history must see *that* salary changed, by whom and when, with values masked.

---

## 7. Errors

| Situation | Code | Status |
|---|---|---|
| Publish without stages | `ERR_BUSINESS_RULE_VIOLATION` | 422 |
| Publish without a terminal stage | `ERR_BUSINESS_RULE_VIOLATION` | 422 |
| Delete a stage holding active applications | `ERR_CONFLICT` | 409 |
| Delete a non-draft job | `ERR_INVALID_TRANSITION` | 409 |
| Reopen a job with a passed `closes_at` | `ERR_BUSINESS_RULE_VIOLATION` | 422 |
| `customFields` fails schema | `ERR_VALIDATION_FAILED` | 422 |
| Payload over 32 KB | `ERR_PAYLOAD_TOO_LARGE` | 413 |
| Version over 60 fields | `ERR_BUSINESS_RULE_VIOLATION` | 422 |
| Editing a published version | `ERR_INVALID_TRANSITION` | 409 |
| Department in another tenant | `ERR_NOT_FOUND` | 404 |
| Confidential job, no access | `ERR_NOT_FOUND` | 404 |

The last one matters: a confidential job you cannot see is 404, never 403 (BR-002).

---

## 8. Tests

**Unit:** schema compiler per field type; required and `additionalProperties` handling; scope predicate composition for each permission combination.

**Integration:**
- Job creation copies stages; later template edit does not affect the job (BR-035)
- Publish preconditions enforced
- `set-confidential` withdraws publicly; clearing it does not republish (BR-033)
- Reorder does not violate uniqueness; concurrent reorders serialize
- Publishing v2 leaves v1 jobs rendering with v1 fields (BR-046)
- Unknown skill auto-created in company scope, not platform scope

**API:**
- Every endpoint: 401, 403, 404-out-of-tenant
- `customFields` validation errors carry correct JSON Pointers
- Salary masked for a non-holder in detail, list, expansion, and audit read
- Payload over 32 KB rejected at the edge, not by the database

**Isolation:**
- Alpha cannot read beta jobs, stages, teams, skills, or form templates
- Hiring manager sees only their departments plus hiring-team jobs
- **Department member does not see a confidential job in their own department** (BR-031)
- Confidential job returns 404, not 403
- Composite FK rejects a job pointing at another tenant's department

**Concurrency:** simultaneous reorders; simultaneous publish of the same template version.

---

## 9. Manual verification before Phase 3

- [ ] Create a custom job form template with three custom fields; publish it
- [ ] Create a job using it; confirm custom fields validate and persist
- [ ] Publish template v2 with a fourth field; confirm the existing job still shows three
- [ ] Create jobs in two departments plus one confidential
- [ ] Log in as a hiring manager in department A — sees A's jobs only
- [ ] Add them to the department-B confidential job's hiring team — now sees it
- [ ] Remove them — no longer sees it
- [ ] Log in as a coordinator — jobs visible, **salary masked with `_masked` populated**
- [ ] Publish a job, then mark it confidential — confirm it leaves the public list
- [ ] Clear confidential — confirm it does **not** return to the public list
- [ ] Reorder stages twice in quick succession — no constraint error
- [ ] Read the job's audit history as a non-salary-holder — change visible, value masked
