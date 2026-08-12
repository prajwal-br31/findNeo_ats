# FindNeo — Business Rules

Every invariant the system must enforce, in EARS syntax, with an enforcement point and a test obligation.

**How to read an entry:**

- **Rule** — the requirement, in EARS form.
- **Enforced at** — `DB` (constraint, trigger, or policy), `SVC` (service layer), `API` (edge validation). Multiple layers mean defence in depth, not redundancy.
- **On violation** — the error code returned (`07-api-standards.md` §6).

**Ids are permanent** (`SPEC-MANIFEST.md`). A retired rule is marked retired, never renumbered.

**Enforcement principle:** a rule whose violation causes data corruption or a privacy breach is enforced in the **database**. A rule that is business policy is enforced in the **service**. A rule about request shape is enforced at the **API edge**. Where a rule appears at more than one layer, the database is authoritative.

---

## 1. Tenancy and isolation

### BR-001
**The system shall** scope every tenant-owned record to exactly one company.
**Enforced at:** DB (`company_id` not null + RLS), SVC (explicit filter, ER-020)
**Note:** one exception — `commission_attributions` (BR-007).

### BR-002
**If** a request references a resource belonging to another company, **then the system shall** respond as though the resource does not exist.
**Enforced at:** DB (RLS), API
**On violation:** `ERR_NOT_FOUND` (404, never 403)

### BR-003
**The system shall** derive tenant identity from the authenticated session only.
**Enforced at:** SVC (ER-023), Semgrep rule 5
**Rationale:** a client-supplied `companyId` is an authorization bypass.

### BR-004
**While** tenant context is unset, **the system shall** return zero rows from every tenant-scoped table.
**Enforced at:** DB (RLS predicate yields NULL → false)
**Rationale:** the failure direction must be "nothing", never "everything".

### BR-005
**The system shall** assign each user to exactly one company.
**Enforced at:** DB (`users.company_id`)
**Exception:** platform staff hold `company_id IS NULL` (BR-006).

### BR-006
**The system shall** grant platform staff no ambient access to any tenant's data.
**Enforced at:** DB (NULL fails every tenant policy), SVC
**Note:** access requires explicit, time-boxed, audited impersonation.

### BR-007
**Where** a commission attribution exists, **the system shall** make it readable by both the hiring company and the sourcing agency, and by no one else.
**Enforced at:** DB (OR policy across two derived paths)
**Note:** the single permitted deviation from BR-001. Individually tested.

### BR-008
**The system shall** reject any association between a user and a department, role, or job belonging to a different company.
**Enforced at:** DB (composite FKs on `(id, company_id)`)
**Rationale:** the join row lives legitimately in your own tenant, so RLS cannot catch this. Only the composite FK can.

---

## 2. Identity and authentication

### BR-010
**The system shall** require a verified email address before a company becomes usable.
**Enforced at:** SVC
**On violation:** `ERR_FORBIDDEN`

### BR-011
**The system shall** require MFA on every account holding the Super Admin role.
**Enforced at:** DB (`trg_owner_requires_mfa`), SVC
**On violation:** `ERR_MFA_REQUIRED`
**Rationale:** this account can reassign every permission in the tenant.

### BR-012
**The system shall** permit exactly one Super Admin per company.
**Enforced at:** DB (partial unique index), SVC
**Note:** transfer is an explicit action; the outgoing owner is demoted in the same transaction.

### BR-013
**When** consecutive failed login attempts reach the configured threshold, **the system shall** lock the account until the lockout expires.
**Enforced at:** SVC (`failed_login_count`, `locked_until` on `users`)
**Note:** there is no `login_attempts` table. Counters are inline.

### BR-014
**The system shall** return an identical response, and take comparable time, for authentication attempts against existing and non-existing accounts.
**Enforced at:** SVC
**Rationale:** prevents account enumeration.

### BR-015
**When** a refresh token is presented that has already been rotated, **the system shall** revoke every session in that token family.
**Enforced at:** SVC
**On violation:** `ERR_UNAUTHENTICATED`
**Rationale:** replay indicates theft; the legitimate holder is logged out deliberately.

### BR-016
**The system shall** store every token — refresh, invitation, candidate action, agency portal — hashed.
**Enforced at:** SVC (ER-047)

### BR-017
**The system shall** not issue authentication credentials to candidates.
**Enforced at:** architecture (candidates are absent from `users`)
**Note:** candidate actions use single-purpose expiring tokens.

### BR-018
**When** a single-use token is consumed, **the system shall** reject all subsequent presentations.
**Enforced at:** DB (consumption timestamp), SVC
**On violation:** `ERR_TOKEN_CONSUMED` (410)

### BR-019
**The system shall** expire an invitation after its validity window and permit only one pending invitation per email per company.
**Enforced at:** DB (partial unique index), SVC

---

## 3. Roles and permissions

### BR-020
**The system shall** derive a user's permissions from `user_roles` only.
**Enforced at:** SVC
**Note:** `user_departments` is membership only. Any reference to `user_departments.role_id` is stale (D-007).

### BR-021
**Where** a user holds several roles, **the system shall** grant the union of their permissions.
**Enforced at:** SVC
**Rationale:** additive, never subtractive. There are no negative permissions — they make effective access impossible to reason about.

### BR-022
**The system shall** permit at most one company-wide grant of a given role per user, and at most one grant of a given role per department per user.
**Enforced at:** DB (two partial unique indexes)

### BR-023
**The system shall** prevent a company from modifying or deleting a platform-default role.
**Enforced at:** DB (`is_editable = false`), SVC

### BR-024
**The system shall** determine job-level assignment exclusively from `job_hiring_team`.
**Enforced at:** SVC
**Rationale:** two systems answering "who works on this job" produce authorization bugs (D-008).

### BR-025
**The system shall** prevent a user from granting a permission they do not themselves hold.
**Enforced at:** SVC
**On violation:** `ERR_FORBIDDEN`
**Rationale:** without this, any user who can edit roles is effectively a Super Admin.

### BR-026
**The system shall** evaluate authorization in a fixed order: authentication and tenant binding, capability, permission, row scope, field masking.
**Enforced at:** SVC (ER-022)

---

## 4. Jobs and pipeline

### BR-030
**The system shall** require a job to belong to exactly one department in the same company.
**Enforced at:** DB (composite FK)

### BR-031
**The system shall** restrict visibility of a confidential job to its hiring team and holders of the confidential-read permission.
**Enforced at:** SVC
**Note:** confidential bypasses ordinary department scope entirely.

### BR-032
**The system shall** exclude confidential, unpublished, and closed jobs from every public surface.
**Enforced at:** DB (`findneo_public` RLS policy)
**Rationale:** in the policy, not the query, so future public endpoints inherit it (D-026).

### BR-033
**When** a job is marked confidential, **the system shall** withdraw it from the public site in the same transaction.
**Enforced at:** SVC
**Note:** clearing the flag does **not** republish. Reappearing publicly is never a side effect.

### BR-034
**The system shall** require at least one pipeline stage and one terminal stage before a job may be published.
**Enforced at:** SVC
**On violation:** `ERR_BUSINESS_RULE_VIOLATION`

### BR-035
**When** a job is created, **the system shall** copy the pipeline template's stages onto the job.
**Enforced at:** SVC
**Rationale:** editing a template must never alter a live job's pipeline mid-hire.

### BR-036
**If** a pipeline stage holds active applications, **then the system shall** reject its deletion.
**Enforced at:** SVC
**On violation:** `ERR_CONFLICT`
**Note:** the stage may be deactivated instead.

### BR-037
**The system shall** maintain unique, gapless stage ordering per job.
**Enforced at:** DB (`UNIQUE(job_id, sequence_order)`), SVC
**Note:** reordering uses a two-phase shift inside one transaction.

### BR-038
**The system shall** require a salary maximum to be greater than or equal to its minimum, and headcount to be positive.
**Enforced at:** DB (CHECK), API

### BR-039
**The system shall** restrict job salary fields to holders of the compensation-read permission.
**Enforced at:** SVC (masking at serialization)

### BR-040
**The system shall** permit closing a job with active applications, and shall not alter those applications.
**Enforced at:** SVC
**Rationale:** closing means "no new applicants", not "cancel in-flight candidates".

---

## 5. Smart forms

### BR-045
**The system shall** resolve the active form template as: company published version, otherwise platform default.
**Enforced at:** SVC
**Note:** the department branch exists but is unreachable in v1 (D-028b).

### BR-046
**When** a job or application is created, **the system shall** record the form template version it was created under.
**Enforced at:** DB (FK not null)
**Rationale:** historical records must render with the fields that existed at the time.

### BR-047
**The system shall** validate custom field values against the JSON Schema compiled from their pinned template version.
**Enforced at:** API (Ajv)
**On violation:** `ERR_VALIDATION_FAILED` with per-field paths

### BR-048
**If** a form template version would exceed 60 fields, or a submitted payload would exceed 32 KB, **then the system shall** reject it.
**Enforced at:** API, SVC
**On violation:** `ERR_PAYLOAD_TOO_LARGE`
**Rationale:** the application form is filled through an unauthenticated endpoint. Without caps a customer can configure a denial-of-service vector against their own public page.

### BR-049
**The system shall** permit at most one published version per template.
**Enforced at:** DB (partial unique index)

### BR-050
**The system shall** not permit a custom field to influence pipeline movement, permissions, masking, or ranking.
**Enforced at:** architecture (D-028)
**Note:** if a requirement demands this, the field is promoted to a typed column and the schema changes.

---

## 6. Candidates and applications

### BR-055
**The system shall** maintain a current, mutable profile on the candidate and an immutable snapshot on each application.
**Enforced at:** SVC
**Note:** the same candidate may legitimately show different stated experience across two applications. That is correct.

### BR-056
**The system shall** never modify an application snapshot after submission.
**Enforced at:** SVC, DB (no update path exposed)

### BR-057
**Where** a company restricts concurrent applications, **the system shall** reject a submission that would exceed the configured cap.
**Enforced at:** DB (trigger with row lock), SVC
**On violation:** `ERR_APPLICATION_CAP_REACHED`
**Note:** default 1, maximum 10. A unique index cannot express "at most N" (D-012).

### BR-058
**The system shall** take a row lock on the candidate before evaluating BR-057.
**Enforced at:** DB
**Rationale:** check-then-act. Without the lock, two simultaneous submissions both pass (ER-030).

### BR-059
**The system shall** permit a candidate to reapply to a job from which they were previously rejected.
**Enforced at:** DB (uniqueness scoped to active status only)

### BR-060
**When** an application is submitted, **the system shall** copy the resume to a new immutable object bound to that application.
**Enforced at:** SVC (copy performed in the worker)
**Rationale:** a later profile resume update must not alter what a hiring team already evaluated.

### BR-061
**The system shall** attempt duplicate detection by email on candidate creation within a company.
**Enforced at:** SVC
**Note:** a match links to the existing candidate; it never merges automatically.

### BR-062
**When** an application is transferred, **the system shall** retain the source application and all its history.
**Enforced at:** SVC
**Note:** expected compensation is not carried forward; the new job's team does not inherit the old job's feedback (D-033).

### BR-063
**The system shall** advance an application only to a stage belonging to its own job's pipeline.
**Enforced at:** DB (composite FK), SVC
**On violation:** `ERR_INVALID_TRANSITION`

### BR-064
**The system shall** require a decision reason when an application is rejected.
**Enforced at:** SVC
**On violation:** `ERR_BUSINESS_RULE_VIOLATION`

### BR-065
**The system shall** record a hire as a stage decision at the final stage.
**Enforced at:** SVC
**Note:** `stage_decisions.decision` includes `hire`. Formal offer management is Phase 2 (D-030).

---

## 7. Agencies and commission

### BR-070
**The system shall** model an agency as a company carrying the agency capability flag.
**Enforced at:** DB (`company_type` bitwise)
**Note:** there is no standalone `agencies` table.

### BR-071
**The system shall** prevent a dual-capacity company from engaging itself.
**Enforced at:** DB (CHECK), SVC
**On violation:** `ERR_BUSINESS_RULE_VIOLATION`

### BR-072
**The system shall** scope an agency user's session to the agency's own company at all times.
**Enforced at:** SVC
**Rationale:** rebinding tenant context to a client would expose that client's internal jobs, feedback, and other agencies' candidates (D-014).

### BR-073
**The system shall** grant an agency access to a client's job only through an active engagement and an explicit assignment.
**Enforced at:** DB (RLS join through `agency_engagements`), SVC

### BR-074
**The system shall** withhold internal feedback, scorecards, internal notes, and other agencies' submissions from every agency user.
**Enforced at:** SVC (masking + scope)

### BR-075
**When** a candidate is hired, **the system shall** attribute commission to the earliest agency-sourced application falling inside the applicable cool-off window.
**Enforced at:** SVC
**Note:** computed once, at hire, then snapshotted.

### BR-076
**The system shall** snapshot the cool-off term and commission rate in effect at the moment of hire.
**Enforced at:** DB (columns on `commission_attributions`)
**Rationale:** contract terms change; a live-computed payout would silently change retroactively.

### BR-077
**The system shall** not block a submission on the basis of another agency's cool-off window.
**Enforced at:** SVC
**Note:** surfaced as a non-blocking report only (D-013).

### BR-078
**When** an engagement is deactivated, **the system shall** retain the agency's existing submissions and their history.
**Enforced at:** SVC

---

## 8. Interviews and feedback

### BR-080
**The system shall** permit only existing hiring team members to add panelists to a job's interviews.
**Enforced at:** DB (trigger), SVC

### BR-081
**The system shall** restrict an interviewer's visibility to their assigned interviews and their own feedback.
**Enforced at:** SVC

### BR-082
**The system shall** withhold other panelists' scores from an interviewer until that interviewer has submitted their own.
**Enforced at:** SVC
**Rationale:** anchoring bias. This is the primary purpose of structured scorecards.

### BR-083
**The system shall** prevent modification of submitted feedback.
**Enforced at:** SVC
**Note:** an amendment is a new record referencing the original.

### BR-084
**The system shall** bind scorecard attributes to a pipeline stage.
**Enforced at:** DB (`UNIQUE(stage_id, attribute_id)`, `trg_focus_attribute_stage_match`)

---

## 9. Data governance and privacy

### BR-090
**The system shall** apply field masking at serialization, after row-level access resolves.
**Enforced at:** SVC (D-025)

### BR-091
**The system shall** apply the same masking rules to audit entries as to the records they describe.
**Enforced at:** SVC
**Rationale:** otherwise the audit trail becomes a bypass of the control it exists to enforce. Field history is often more revealing than the field.

### BR-092
**The system shall** serialize responses from an explicit allowlist.
**Enforced at:** SVC (Fastify response schemas, ER-025)
**Rationale:** a new column must never be able to reach a response by accident.

### BR-093
**When** an erasure request is verified, **the system shall** anonymize personal data while retaining rows, relationships, and dates.
**Enforced at:** SVC (D-034)
**Rationale:** cool-off, commission attribution, and audit integrity all require the rows to survive.

### BR-094
**The system shall** never write personal data to logs, traces, error reports, job payloads, or webhook payloads.
**Enforced at:** SVC (ER-048), Pino redaction

### BR-095
**The system shall** record every state-changing action with actor, role in effect, timestamp, and field-level changes.
**Enforced at:** SVC
**Note:** `audit_logs` is append-only; the application role holds no UPDATE or DELETE grant.

### BR-096
**The system shall** prevent modification or deletion of audit records.
**Enforced at:** DB (grants)

---

## 10. Async and integrity

### BR-100
**The system shall** commit a job enqueue in the same transaction as the state change that triggers it.
**Enforced at:** SVC (ER-028)
**Rationale:** otherwise a committed row can lose its notification, or a job can fire for a rolled-back row.

### BR-101
**The system shall** write cross-boundary events to the outbox within the originating transaction.
**Enforced at:** SVC (D-031)

### BR-102
**The system shall** produce the same end state when a job or event is processed more than once.
**Enforced at:** SVC (ER-041)
**Rationale:** delivery is at-least-once, always.

### BR-103
**When** a side-effecting request repeats an idempotency key with an identical body, **the system shall** return the stored response without re-executing.
**Enforced at:** SVC
**On violation (different body):** `ERR_IDEMPOTENCY_CONFLICT`

### BR-104
**The system shall** return a run identifier immediately for long-running operations rather than holding the request.
**Enforced at:** API (202, ER-045)

---

## 11. AI boundaries

### BR-110
**The system shall** not permit an AI output to reject, select, or hire a candidate automatically.
**Enforced at:** architecture (D-029)
**Rationale:** structural, not a preference. Automated adverse decisions carry regulatory exposure in every target market.

### BR-111
**The system shall** make every AI output reviewable and editable by the responsible human before it takes effect.
**Enforced at:** SVC

### BR-112
**The system shall** record model identity and version on every AI-produced record.
**Enforced at:** DB (provenance columns)
**Rationale:** without it, a scoring dispute months later is unanswerable.

### BR-113
**The system shall** apply the same tenant isolation and masking rules to AI-produced records as to any other record.
**Enforced at:** DB (RLS), SVC

---

## 12. Coverage obligations

- Every rule above has at least one automated test citing its id (ER-055).
- Every rule marked **DB** additionally has a test that attempts the violation through raw SQL, bypassing the service layer. A database-enforced rule that only fails in the service is not database-enforced.
- Every rule involving "at most", "only if none", or "first" has a concurrency test (ER-057).
- BR-002, BR-004, BR-006, BR-008, BR-032, BR-072, and BR-074 are **isolation-critical**: their tests run in a dedicated suite that gates deployment.
