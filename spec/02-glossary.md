# FindNeo — Glossary

One name per concept, used identically in specs, code, database, API, and UI.

**Binding rule:** if a term is here, use exactly this word. Do not introduce a synonym in code because it reads better locally. Synonyms are how two developers build two models of the same thing.

---

## Tenancy & identity

**Company** — the tenant. One row in `companies`. Every tenant-scoped record belongs to exactly one. *Never* call this "organization" in code — see below.

**Organization** — a company operating in hiring mode. A *capability*, not a separate entity. In code and schema the word is **company**; "organization" appears only in user-facing copy and the `organization` capability value.

**Agency** — a company operating in placement mode. Also a capability. **There is no `agencies` table.** Any reference to one is stale (D-035).

**Capability** — which mode a company operates in. Bitwise on `companies.company_type`: 1 organization, 2 agency, 3 both.

**Dual-capacity company** — one company holding both capabilities. One row, one identity, two views. Cannot engage itself (BR-071).

**Tenant context** — the `company_id` bound to the current transaction via `set_config('app.current_company_id', $1, true)`. The basis of every RLS policy.

**Platform staff / System Admin** — internal FindNeo employees. `users` rows with `company_id IS NULL`. No ambient tenant access.

**Super Admin** — the *customer's* tenant owner. Exactly one per company, MFA mandatory.

> **System Admin and Super Admin are not interchangeable.** This confusion appears in earlier documents and has real security consequences.

**User** — an authenticated human operator. Belongs to exactly one company. **Candidates are never users.**

**Department** — an organisational unit within a company. Flat, no hierarchy in v1. A row-scope boundary.

---

## Access control

**Permission** — an atomic capability, `<resource>.<action>` (e.g. `jobs.publish`). Platform-wide fixed catalog; companies compose but cannot invent.

**Role** — a named bundle of permissions. Platform defaults (`company_id IS NULL`, uneditable) or company custom.

**Role assignment** — a `user_roles` row: user + role, optionally scoped to a department. **The only source of permissions** (D-007).

**Scope** — a role's breadth: `platform` / `company` / `department` / `job`.

**Row scope** — which specific rows a permission-holder can reach. Distinct from the permission itself: `jobs.read` says you may read jobs; row scope says *which*.

**Field masking** — withholding a field from a caller who can see the row but not that field. Applied server-side at serialization, never client-side (D-025).

**Capability switch** — changing between organization and agency view. Issues a new access token; never mutates one.

**Impersonation** — explicit, time-boxed, audited platform-staff access to a tenant. Never ambient.

---

## Hiring

**Job** — an open position. Sometimes called a requisition; **use "job"**.

**Pipeline** — the ordered stages a candidate moves through for a job.

**Pipeline template** — a reusable stage blueprint. **Copied onto a job at creation** — editing a template never alters a live job (BR-035).

**Stage** — one step in a job's pipeline. Belongs to a job, not to a template, once copied.

**Terminal stage** — a stage from which no advance is possible: hired or rejected.

**Hiring team** — users assigned to a specific job via `job_hiring_team`. The **sole** source of job-level assignment (D-008).

**Confidential job** — a job visible only to its hiring team and holders of `jobs.confidential.read`. Department membership alone is never sufficient.

**Job skill** — a required skill with years, mandatory flag, and weight. Structured because the Resume Ranker consumes it.

---

## Candidates & applications

**Candidate** — a person being considered. Has a **current, mutable profile**. Never authenticates, never has an account (D-015).

**Candidate profile** — the current state of a candidate. Updates freely.

**Application** — one candidate's pursuit of one job. Carries an **immutable snapshot**.

**Snapshot** — the candidate's details frozen at submission, in `snapshot_*` columns. Never updated (BR-056). A candidate may legitimately show different details across two applications; that is correct.

> **Profile vs snapshot is the most important distinction in the data model.** The profile is what the candidate is now. The snapshot is what they claimed then. Both are needed; neither derives from the other (D-009).

**Talent pool** — candidates tracked before any application exists. `talent_pool_entries` holds membership and provenance only — no profile fields (D-010).

**Pool entry** — one candidate's membership of one company's pool.

**Source** — how a candidate entered: `self_apply` / `internal_add` / `agency` / `pool_conversion` / `referral`.

**Profile resume** — the candidate's current resume. One per candidate, updatable.

**Application resume** — a frozen copy taken at submission. Immutable. Changing the profile resume never affects it (D-011).

**Stage decision** — the recorded human verdict at a stage: `advance` / `reject` / `hold` / `hire`. Append-only.

**Decision reason** — a company-configurable catalog entry explaining a reject or hire. Multi-select per decision.

**Transfer** — moving a candidate to a different job. **Non-destructive**: the source application and its history survive (D-033).

**Application cap** — the configurable limit on concurrent active applications per candidate per company. Default 1, maximum 10. Enforced by trigger with a row lock (D-012).

---

## Interviews & evaluation

**Interview** — a scheduled evaluation session tied to an application and a stage.

**Panelist** — a user assigned to conduct an interview. Need not be on the hiring team; only a hiring team member may add one (BR-080).

**Slot** — a proposed time. The candidate selects one via an expiring token.

**Scorecard** — one panelist's structured feedback on one interview. **Immutable once submitted**; an amendment is a new record (BR-083).

**Scorecard attribute** — a competency being evaluated.

**Focus attribute** — which attributes a given **stage** evaluates. Stage-keyed, never job-keyed.

**Anchoring protection** — withholding peer scores until the viewer has submitted their own. The primary purpose of structured scorecards (BR-082).

---

## Agencies & commission

**Engagement** — the formal relationship between a client company and an agency company. Carries commission terms and the cool-off window.

**Job assignment** — granting an agency access to a specific job. Points at an **engagement**, never at an agency directly, so a grant cannot exist without an authorising engagement.

**Submission** — an agency introducing a candidate to a client's job.

**Cool-off period** — the window after an agency referral during which that agency retains commission rights even if the hire happens by another route. Resolved **only at hire time**; never blocks a submission (D-013).

**Commission attribution** — the record of which agency is owed commission for a hire. Written once, at hire, with terms **snapshotted** (D-035). Never computed live.

**Lookback** — the hire-time query finding the earliest qualifying agency referral inside the cool-off window.

---

## Platform mechanics

**Smart form** — a company-configurable form for job creation or application. Typed columns for anything the system reasons about; JSONB for the rest (D-028).

**Form template** — a company's form definition for one entity type.

**Template version** — a frozen snapshot of field definitions. Records pin the version they were created under, so historical rendering stays correct.

**Custom field** — a company-defined field stored in `custom_fields` JSONB. **May never drive pipeline movement, permissions, masking, or ranking.**

**Typed column** — a real database column. Everything the system reasons about.

**Port / adapter** — the interface and implementation isolating an external dependency. Forced by on-premise (D-004).

**Outbox** — the table cross-boundary events are written to, inside the originating transaction, then relayed by the worker (D-031).

**Idempotency key** — a client-supplied identifier making a side-effecting POST safely retryable.

**Cursor** — the opaque pagination token. No offset pagination anywhere (D-023).

**Action endpoint** — `POST /{resource}/{id}/actions/{verb}` for a business state transition. `PATCH` is for simple field edits only.

**Anonymization** — scrubbing personal data while retaining rows, relationships, and dates. **The only erasure mechanism** — never hard delete (D-034).

---

## Deployment

**Hosted / SaaS** — FindNeo-operated, shared database, pool multi-tenancy.

**On-premise** — customer-operated, fully isolated stack. Same software, different configuration — **not** a tenancy variant (D-002).

**Pool model** — shared database, RLS isolation. The primary tenancy model.

**API server** — the process serving HTTP.

**Worker** — the process consuming pg-boss jobs. Same codebase, same tenant-binding discipline.

---

## Prohibited terms

Words that must not appear in code, schema, or new specs. Each names something that no longer exists or duplicates a term above.

| Do not use | Use instead |
|---|---|
| `organization_memberships`, `membership_roles` | `user_roles` |
| `user_departments.role_id` | `user_roles` |
| `login_attempts` | inline counters on `users` |
| `agencies` table | `companies` with the agency capability |
| `org_candidate_pool`, `agency_candidate_pool` | `talent_pool_entries` |
| `applications.resume_url` | `candidate_resumes` |
| `trg_focus_attribute_job_match` | `trg_focus_attribute_stage_match` |
| "organization" as a code entity | `company` |
| "requisition" | `job` |
| "recruiter portal" | agency portal |
| "tenant id" in code | `companyId` |
| "soft delete" for personal data | anonymization |
