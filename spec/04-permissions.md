# FindNeo — Permissions & Authorization

The complete authorization model: the pipeline, the permission catalog, the role matrix, row-scope rules, and field masking.

**This document supersedes the uploaded RBAC proposal** wherever they differ. That document predates the companies merge (D-035), the `user_roles` decision (D-007), and the agency isolation fix (D-014).

---

## 1. The authorization pipeline

Five steps, fixed order, every authenticated request (ER-022). No step may be skipped or reordered.

```
1. AUTHENTICATE   valid token? session live? → 401
2. BIND TENANT    set_config('app.current_company_id', …, true) inside the transaction
3. CAPABILITY     organization vs agency view → 403 ERR_CAPABILITY_MISMATCH
4. PERMISSION     does any held role grant the required key? → 403 ERR_FORBIDDEN
5. ROW SCOPE      is this specific row in reach? → 404 ERR_NOT_FOUND
6. FIELD MASK     applied at serialization, after the row is resolved
```

**Why this order.** Tenant binding precedes everything, so no later step can operate on another tenant's row. Row scope precedes masking, because you cannot mask fields on a row you cannot see. Row-scope failure returns 404 rather than 403 — a 403 confirms the row exists (BR-002).

**Where each step lives:** steps 1–2 are middleware. Step 3–4 are declarative route metadata. Step 5 is inside the repository query. Step 6 is the Fastify response schema plus the masking layer.

Step 5 belongs in the query, not in a post-fetch filter. Filtering after fetch means the row was already loaded, which shows up in timing and in logs, and invites a developer to use it "just this once".

---

## 2. Permission catalog

Permission keys are platform-wide and fixed. Companies compose them into roles; they cannot invent permission types.

**Naming:** `<resource>.<action>` — with `.all` denoting a scope widening and `.<field>.read` denoting field-level access.

### Company & configuration

| Key | Grants |
|---|---|
| `company.read` | View company profile |
| `company.update` | Edit company profile |
| `company.settings.manage` | Change settings including the application cap |
| `company.billing.manage` | Billing — Phase 2, reserved |

### Users

| Key | Grants |
|---|---|
| `users.read` | List and view users |
| `users.invite` | Send invitations |
| `users.update` | Edit user profiles |
| `users.deactivate` | Deactivate a user |
| `users.impersonate` | Platform staff only, audited |

### Roles & permissions

| Key | Grants |
|---|---|
| `roles.read` | View roles and their permissions |
| `roles.create` · `roles.update` · `roles.delete` | Manage custom roles |
| `roles.assign` | Grant and revoke role assignments |

### Departments

| Key | Grants |
|---|---|
| `departments.read` · `.create` · `.update` · `.delete` | Manage departments |
| `departments.members.manage` | Add and remove members |

### Jobs

| Key | Grants |
|---|---|
| `jobs.read` | View jobs **in scope** (§4) |
| `jobs.read.all` | View every job company-wide |
| `jobs.confidential.read` | View confidential jobs outside the hiring team |
| `jobs.create` · `jobs.update` · `jobs.delete` | Manage jobs |
| `jobs.publish` · `jobs.close` | Lifecycle actions |
| `jobs.salary.read` | See compensation on jobs |
| `jobs.team.read` · `jobs.team.manage` | Hiring team |

### Pipeline & forms

| Key | Grants |
|---|---|
| `pipeline.read` · `pipeline.configure` | Per-job stages |
| `pipeline.templates.manage` | Company-wide templates |
| `forms.read` · `forms.configure` | Smart form templates |

### Candidates & applications

| Key | Grants |
|---|---|
| `candidates.read` · `.create` · `.update` | Candidate profiles |
| `candidates.compensation.read` | Current and expected compensation |
| `candidates.contact.read` | Email and phone |
| `applications.read` · `.create` | Applications |
| `applications.advance` · `.reject` · `.transfer` · `.hire` | Lifecycle actions |
| `applications.resume.download` | Download resume files |
| `talent_pool.read` · `.manage` | Pool entries |

**`applications.hire` is separate from `applications.advance`** because it is the trigger for commission attribution — a financial event.

### Interviews & scorecards

| Key | Grants |
|---|---|
| `interviews.read` · `.schedule` · `.reschedule` · `.cancel` | Interviews |
| `interviews.panel.manage` | Panelists |
| `scorecards.read.own` | Own submitted feedback |
| `scorecards.read.all` | All feedback on an application |
| `scorecards.submit` | Submit feedback |
| `scorecards.configure` | Attributes and templates |

### Agencies

| Key | Grants |
|---|---|
| `agencies.read` · `.invite` · `.manage` | Engagements |
| `agencies.assign_job` | Assign a job to an agency |
| `agency_portal.access` | Use the agency portal at all |
| `agency.submissions.create` | Submit a candidate |
| `commission.read` · `commission.manage` | Attribution records |

### Governance

| Key | Grants |
|---|---|
| `audit.read` | Audit log |
| `activity.read` | Activity feed |
| `data_governance.manage` | Field visibility rules |
| `gdpr.erasure.execute` | Anonymization |
| `reports.read` · `reports.export` | Reporting |

### Platform (staff only)

| Key | Grants |
|---|---|
| `platform.companies.read` · `.manage` | Tenant administration |
| `platform.support.impersonate` | Time-boxed, audited tenant access |
| `platform.system.read` | Health and metrics |

---

## 3. Role matrix

Platform-default roles, seeded with `company_id IS NULL` and `is_editable = false`. Companies clone these to create custom roles.

`●` full · `◐` scoped (see §4) · `○` none

| Permission group | System Admin | Super Admin | HR Admin | Hiring Mgr | Recruiter | Coordinator | Interviewer | Agency |
|---|---|---|---|---|---|---|---|---|
| Company read | ○ | ● | ● | ● | ● | ● | ● | ○ |
| Company update | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ |
| Settings manage | ○ | ● | ◐ | ○ | ○ | ○ | ○ | ○ |
| Users read | ○ | ● | ● | ◐ | ◐ | ◐ | ○ | ○ |
| Users invite/update | ○ | ● | ● | ○ | ○ | ○ | ○ | ○ |
| Roles read | ○ | ● | ● | ○ | ○ | ○ | ○ | ○ |
| Roles manage/assign | ○ | ● | ◐ | ○ | ○ | ○ | ○ | ○ |
| Departments manage | ○ | ● | ● | ○ | ○ | ○ | ○ | ○ |
| Jobs read | ○ | ● | ● | ◐ | ◐ | ◐ | ◐ | ◐ |
| Jobs read all | ○ | ● | ● | ○ | ○ | ○ | ○ | ○ |
| Jobs confidential | ○ | ● | ● | ◐ | ○ | ○ | ○ | ○ |
| Jobs create/update | ○ | ● | ● | ◐ | ○ | ○ | ○ | ○ |
| Jobs publish/close | ○ | ● | ● | ◐ | ○ | ○ | ○ | ○ |
| Jobs salary read | ○ | ● | ● | ◐ | ◐ | ○ | ○ | ○ |
| Hiring team manage | ○ | ● | ● | ◐ | ○ | ○ | ○ | ○ |
| Pipeline configure | ○ | ● | ● | ◐ | ○ | ○ | ○ | ○ |
| Forms configure | ○ | ● | ● | ○ | ○ | ○ | ○ | ○ |
| Candidates read | ○ | ● | ● | ◐ | ◐ | ◐ | ◐ | ◐ |
| Candidates contact | ○ | ● | ● | ◐ | ◐ | ◐ | ○ | ◐ |
| Candidates compensation | ○ | ● | ● | ◐ | ◐ | ○ | ○ | ○ |
| Applications read | ○ | ● | ● | ◐ | ◐ | ◐ | ◐ | ◐ |
| Applications advance/reject | ○ | ● | ● | ◐ | ◐ | ○ | ○ | ○ |
| Applications hire | ○ | ● | ● | ◐ | ○ | ○ | ○ | ○ |
| Resume download | ○ | ● | ● | ◐ | ◐ | ◐ | ◐ | ◐ |
| Interviews schedule | ○ | ● | ● | ◐ | ◐ | ◐ | ○ | ○ |
| Panel manage | ○ | ● | ● | ◐ | ◐ | ◐ | ○ | ○ |
| Scorecards submit | ○ | ● | ● | ◐ | ◐ | ○ | ◐ | ○ |
| Scorecards read all | ○ | ● | ● | ◐ | ◐ | ○ | ○ | ○ |
| Agencies manage | ○ | ● | ● | ○ | ◐ | ○ | ○ | ○ |
| Agency portal access | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● |
| Commission read | ○ | ● | ● | ○ | ○ | ○ | ○ | ◐ |
| Audit read | ○ | ● | ◐ | ○ | ○ | ○ | ○ | ○ |
| GDPR erasure | ○ | ● | ◐ | ○ | ○ | ○ | ○ | ○ |
| Platform admin | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ |

### Notes on specific cells

**System Admin holds no tenant permission at all.** Every column outside the platform group is `○`. Tenant access requires `platform.support.impersonate`, which is time-boxed, requires a stated reason, and writes an audit record visible to the tenant's Super Admin (BR-006).

**Coordinator sees no compensation and no scorecard scores.** They schedule and coordinate; they have no evaluative role. This actor appears in the PRD and RBAC matrix and was missing from `product_spec_v1.md`.

**Interviewer holds `scorecards.read.own`, never `.all`** — enforcing BR-082's anchoring-bias protection.

**Agency holds `commission.read` scoped to its own attributions only** (BR-007), and never sees scorecards, internal notes, or other agencies' submissions (BR-074).

---

## 4. Row scope

What `◐` means, per resource. Evaluated in the query (§1).

### Jobs

Visible if **any** holds:
1. `jobs.read.all`, **or**
2. the job's department is one of the user's departments, **or**
3. the user is on `job_hiring_team` for that job

**Confidential override:** a confidential job requires condition 3 **or** `jobs.confidential.read`. Department membership alone is never sufficient (BR-031).

```sql
WHERE j.company_id = current_setting('app.current_company_id')::uuid
  AND (
        :has_read_all
     OR (NOT j.confidential AND j.department_id = ANY(:user_department_ids))
     OR (j.confidential AND :has_confidential_read)
     OR EXISTS (SELECT 1 FROM job_hiring_team t
                 WHERE t.job_id = j.id AND t.user_id = :user_id)
  )
```

### Applications and candidates

Reachable if the user can see the application's job. Interviewers narrow further: only applications with an interview they are assigned to.

Candidates are reachable through a visible application, or through a talent pool entry the user can access.

### Interviews

Schedulers see interviews on visible jobs. Interviewers see only their own assignments.

### Scorecards

`scorecards.read.all` sees every submission on a visible application. `scorecards.read.own` sees only their own — and other panelists' scores stay hidden until the viewer has submitted (BR-082).

### Agency portal

Every query joins through `agency_engagements`. The session never rebinds tenant context (BR-072). Reachable rows require an active engagement **and** an explicit job assignment.

---

## 5. Field masking

Applied at serialization, after row scope resolves (BR-090). Driven by `field_visibility_rules`; company rules override platform defaults; no row means unmasked.

### Default rules

| Table | Field | Required permission |
|---|---|---|
| `jobs` | `salary_min`, `salary_max` | `jobs.salary.read` |
| `candidates` | `email`, `phone` | `candidates.contact.read` |
| `candidates` | `current_ctc` | `candidates.compensation.read` |
| `applications` | `expected_ctc`, `notice_period` | `candidates.compensation.read` |
| `applications` | `internal_notes` | `applications.read` + non-agency capability |
| `scorecards` | `overall_rating`, `comments` | `scorecards.read.all` or own |
| `commission_attributions` | `commission_rate`, `amount` | `commission.read` |

### Wire representation

Per `07-api-standards.md` §8: masked fields are `null` with the field name listed in `_masked`, or omitted entirely where existence itself is sensitive.

### Applies everywhere

Collection items, expanded sub-resources, exports, webhook payloads, and **audit entries** (BR-091). Masking that stops at the primary endpoint is not masking.

---

## 6. Capability switching

A dual-capacity company (`company_type = 3`) operates in one view at a time, selected by `X-Capability` and stored on the session.

| | Organization view | Agency view |
|---|---|---|
| Sees | Own jobs, own candidates, own hiring | Client engagements, own submissions |
| Route namespace | `/v1/…` | `/v1/agency/…` |
| Tenant binding | Own company | Own company (**never the client's**) |

Requesting an agency-view resource while in organization view returns 403 `ERR_CAPABILITY_MISMATCH`. Switching capability issues a new access token; it never mutates an existing one.

**A company can never engage itself** (BR-071) — the two capabilities of one company are not counterparties.

---

## 7. Permission resolution

```
effective = ⋃ permissions of all roles held by the user
```

Additive union (BR-021). **No negative permissions**, ever — a deny that overrides a grant makes effective access impossible to reason about and impossible to test exhaustively.

**Resolution cost.** Computed per request from `user_roles → role_permissions`, cached in-process keyed by `(companyId, userId, rolesVersion)` (ER-024 — the tenant portion is mandatory). `rolesVersion` is bumped on any role change in the company, so a revocation takes effect on the next request rather than after a TTL.

**Access tokens carry no permission list** (D-020). A baked-in list means a revoked permission stays live until the token expires.

**Privilege escalation guard:** a user may not grant a permission they do not hold (BR-025). Without it, `roles.assign` is equivalent to Super Admin.

---

## 8. Route declaration

Every route declares its requirement in metadata, not in handler code:

```ts
fastify.post('/v1/jobs/:jobId/actions/publish', {
  schema: { /* TypeBox params, body, responses */ },
  config: {
    permission: 'jobs.publish',
    capability: 'organization',
    scope: 'job',
    rateLimit: 'authenticated.general',
  },
}, publishJobController);
```

A route without a `permission` entry **fails to register** at boot. Fail-closed: a forgotten permission must break the build, not silently expose an endpoint.

CI additionally asserts that every route in the OpenAPI output names a permission that exists in the catalog.

---

## 9. Test obligations

Per role, per resource:

1. Holder of the permission succeeds.
2. Non-holder receives 403.
3. Holder acting on an out-of-scope row receives **404**, not 403.
4. Holder from another tenant receives 404.
5. Masked fields absent or null, with `_masked` populated, for a non-holder.
6. The same masking applies through expansion, export, webhook, and audit read.

Additionally:

- **Escalation:** a user with `roles.assign` but not `jobs.salary.read` cannot grant `jobs.salary.read` (BR-025).
- **Confidential:** department membership alone does not reveal a confidential job (BR-031).
- **Anchoring:** an interviewer cannot read peer scores before submitting their own (BR-082).
- **Agency isolation:** an agency user cannot reach the client's internal jobs, other agencies' submissions, or any scorecard (BR-072, BR-074).
- **Impersonation:** platform staff reading tenant data without an active impersonation grant receive 404, and every impersonated read is audited (BR-006).
- **Route coverage:** every registered route names a catalog permission — asserted as a test, not a convention.
