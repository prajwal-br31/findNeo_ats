# FindNeo — Delivery Plan

Build order, phase gates, and what "complete" means for each module.

**Principle:** each phase ends with a working, tested, demonstrable slice. No phase leaves a module half-built to start the next. A module is complete when its isolation tests pass — not when its happy path works.

**Not in scope:** calendar integration and interview scheduling (D-042), AI ranking and matching. Contracts with those teams are O-014 and O-001.

**Model selection per task type** (Claude Code):

| Work | Model |
|---|---|
| RLS policies, tenant binding, auth, permission resolution, masking, triggers with locks | **Opus 5** |
| CRUD, mappers, DTOs, tests against a written spec, migrations transcribed from spec | **Sonnet 5** |

The split is roughly 20/80. Opus for anything where a subtle mistake is a security bug rather than a wrong answer.

---

## Phase 0 — Foundation

**No feature code. This is the phase most likely to be rushed and most expensive to get wrong.**

| # | Task | Model |
|---|---|---|
| T-001 | Repo, pnpm workspace, `tsconfig` strict flags (ER-012) | Sonnet |
| T-002 | ESLint + `eslint-plugin-boundaries` wired to ER-001/ER-007, Prettier, husky, commitlint | Sonnet |
| T-003 | The seven Semgrep rules (`05a` §9) | **Opus** |
| T-004 | Docker Compose: Postgres 18, MinIO | Sonnet |
| T-005 | Config loader with startup schema validation, fail-fast (SEC-060) | Sonnet |
| T-006 | Folder structure per ER-008 (bff / modules / workers / platform) | Sonnet |
| T-006a | **Boundary rules: BFF cannot import repositories; domain cannot import Drizzle** | **Opus** |
| T-007 | **`platform/db`: transaction helper + `set_config` binding** | **Opus** |
| T-008 | Five port interfaces + v1 implementations | Sonnet |
| T-009 | `shared/errors`: `AppError` hierarchy, RFC 7807 mapper, error catalog | Sonnet |
| T-010 | `shared/http`: envelope, cursor pagination, idempotency middleware. **Includes migration 001b (`idempotency_keys`) so this lands fully tested** | **Opus** |
| T-011 | Test harness: `findneo_test_runner` role, test-DB migration path, template build, clone per test, pool discipline. **Fixture body deferred to T-020a** (D-048) | **Opus** |
| T-012 | Fastify bootstrap: helmet, cors, cookie, rate-limit, swagger, under-pressure | Sonnet |
| T-013 | Worker bootstrap: six domains, per-domain policy config, tenant binding, retry, dead-letter | **Opus** |
| T-013a | **Tenant-fairness claim query in `QueuePort`** (D-040) | **Opus** |
| T-013b | BFF module skeleton, `/bff/web/*` namespace, session adaptation | Sonnet |
| T-014 | Pino with PII redaction paths, OpenTelemetry, `/health/live` + `/health/ready` | Sonnet |
| T-015 | CI pipeline per `11` §9 | Sonnet |
| T-015a | **Consolidate control-integrity assertions** into one deploy-gating suite (`11` §3a) | **Opus** |

**Gate — none of this is optional:**
- [ ] T-007 proves: unset context returns **zero** rows, not all rows
- [ ] Tenant context never escapes its request under concurrent load (SEC-005) — test with parallel requests, not sequentially
- [ ] Semgrep rules fire on deliberately planted violations
- [ ] Boundaries linter rejects a controller importing a repository
- [ ] Both processes start, connect, and pass health checks
- [ ] Linter rejects a BFF file importing a repository, and a domain file importing Drizzle
- [ ] Six queue domains register with distinct policies
- [ ] **Tenant fairness proven: one tenant flooding a domain does not stall another tenant's jobs in the same domain**

**T-007 and T-011 are the highest-leverage work in the project.** Everything above them inherits their correctness, and a subtle error in either is invisible in every subsequent test. Budget real time; do not let an agent one-shot them.

---

## Phase 1 — Identity & Access

Migrations 001–015. Spec: `06-data-model.md`, `08-lld-identity.md`, `04-permissions.md`.

| # | Task | Model |
|---|---|---|
| T-020 | Migrations 002–009 (companies → audit). 001 and 001b land in Phase 0 | Sonnet |
| T-021 | **Migration 013: RLS enable, force, policies** | **Opus** |
| T-020a | **`seedTwoTenants` body** — two companies, departments, users across every role (D-048b) | **Opus** |
| T-022 | Migration 015: seed permissions, roles, defaults | Sonnet |
| T-023 | Schema assertion test: every `company_id` table has RLS forced | **Opus** |
| T-024 | Signup: company + owner + verification, one transaction | **Opus** |
| T-025 | Login, MFA, lockout, uniform responses | **Opus** |
| T-026 | Refresh rotation with family revocation | **Opus** |
| T-027 | Permission resolution + tenant-keyed cache | **Opus** |
| T-028 | Authorization middleware, route metadata, fail-closed registration | **Opus** |
| T-029 | Masking layer + `field_visibility_rules` resolution | **Opus** |
| T-030 | Users CRUD, invitations | Sonnet |
| T-031 | Departments, membership | Sonnet |
| T-032 | Roles, role assignment, escalation guard | **Opus** |
| T-033 | Platform admin surface + audited impersonation | **Opus** |
| T-034 | Isolation suite for this module | **Opus** |

**Gate:**
- [ ] Two tenants, full role set, zero cross-tenant reachability on every route
- [ ] Composite FK rejects cross-tenant department attachment (BR-008)
- [ ] Super Admin without MFA rejected **by the database** (BR-011)
- [ ] Rotated refresh replay revokes the family (BR-015)
- [ ] `roles.assign` holder cannot grant a permission they lack (BR-025)
- [ ] Route without a permission fails to register (SEC-021)
- [ ] Platform staff invisible to every tenant; impersonation audited (BR-006)
- [ ] Every `BR-001`–`BR-026` has a citing test

**Demo:** sign up a company, invite users across every role, assign departments, log in as each, observe different visibility.

This phase is disproportionately Opus because it *is* the security model. Everything later trusts it.

---

## Phase 2 — Jobs, Forms & Pipeline

Migrations 010–012. Spec: `06-data-model.md` §5–6, `08-lld-jobs.md`.

| # | Task | Model |
|---|---|---|
| T-040 | Migrations 010–012 | Sonnet |
| T-041 | Form templates, versions, fields; publish freezes a version | Sonnet |
| T-042 | Field definitions → JSON Schema compilation + caching | **Opus** |
| T-043 | Seed platform-default job and application templates | Sonnet |
| T-044 | Jobs CRUD with `custom_fields` validation | Sonnet |
| T-045 | Job row-scope query: department, hiring team, confidential (§4 of `04`) | **Opus** |
| T-046 | Pipeline templates; stage copy at job creation; reorder | Sonnet |
| T-047 | Hiring team management | Sonnet |
| T-048 | Skills catalog + `job_skills` with weights | Sonnet |
| T-049 | Publish / close actions; confidential withdrawal transition | **Opus** |
| T-050 | Salary masking | **Opus** |
| T-051 | Isolation + scope suite | **Opus** |

**Gate:**
- [ ] Hiring manager sees only their departments' jobs plus hiring-team jobs
- [ ] Department membership alone does **not** reveal a confidential job (BR-031)
- [ ] Salary masked for non-holders, including in lists and expansions
- [ ] Publishing template v2 leaves v1 jobs rendering with v1 fields (BR-046)
- [ ] Payload over 32 KB rejected at the edge (BR-048)
- [ ] Marking a published job confidential withdraws it publicly (BR-033)
- [ ] Stage reorder does not violate the unique constraint mid-transaction

**Demo:** configure a custom job form, create jobs in two departments plus one confidential, show four roles seeing four different views.

---

## Phase 3 — Candidates & Applications

Migrations 016–017. Spec: `06b` §1–2.

| # | Task | Model |
|---|---|---|
| T-060 | Migrations 016–017 | Sonnet |
| T-061 | **Application cap trigger with row lock** | **Opus** |
| T-062 | Candidates CRUD + fuzzy duplicate detection | Sonnet |
| T-063 | `talent_pool_entries` | Sonnet |
| T-064 | Resume upload: magic-byte validation, storage adapter | **Opus** |
| T-065 | Application submission: snapshot + resume copy job | **Opus** |
| T-066 | Stage advance / reject / hold actions | Sonnet |
| T-067 | Decision reasons, multi-select | Sonnet |
| T-068 | Non-destructive transfer (D-033) | **Opus** |
| T-069 | Withdrawal via candidate token | Sonnet |
| T-070 | Compensation masking across candidates and applications | **Opus** |
| T-071 | Concurrency suite: cap race, duplicate submit | **Opus** |

**Gate:**
- [ ] Simultaneous submissions with cap 1: exactly one succeeds (BR-058)
- [ ] Profile update does not alter any existing application snapshot (BR-056)
- [ ] Profile resume replacement leaves the application copy byte-identical (BR-060)
- [ ] Rejected candidate can reapply to the same job (BR-059)
- [ ] Transfer retains the source application and its history (BR-062)
- [ ] Org cannot read an agency's pool (BR-001 via `owner_company_id`)
- [ ] Compensation masked everywhere including exports

**Demo:** add candidates four ways, run one through a pipeline, transfer another, show a rejection with reasons.

---

## Phase 4 — Career Site (hosted)

Spec: `07` §12, `10` §7, D-043. **Hosted page only — the embed widget is Phase 2.**

| # | Task | Model |
|---|---|---|
| T-080 | `findneo_public` role, grants, public RLS policies | **Opus** |
| T-081 | Public job list and detail, slug tenant resolution | **Opus** |
| T-082 | Public form definition endpoint | Sonnet |
| T-083 | Public application submission + upload | **Opus** |
| T-084 | Public rate limits, bot-check hook | Sonnet |
| T-085 | Hosted career page (server-rendered, slug-addressed) | Sonnet |
| T-086 | Surface the career page URL in tenant onboarding | Sonnet |
| T-087 | Public surface security suite | **Opus** |

**Gate:**
- [ ] Raw `SELECT * FROM jobs` as `findneo_public` returns no confidential or unpublished row (SEC-051)
- [ ] `findneo_public` cannot read any user, candidate, or scorecard row
- [ ] Unpublished, confidential, and nonexistent all return identical 404s (SEC-053)
- [ ] Public projection built fresh, not the internal object stripped (SEC-052)
- [ ] CORS on public routes restricted to the career-page origin; authenticated routes unaffected
- [ ] Rate limits hold under a burst
- [ ] A candidate can apply end to end without an account

**Deliberately after Phase 3:** the only unauthenticated write path should be built once the application model beneath it is already proven.

**Not in this phase** (D-043): embed script, iframe fallback, per-company embedding-origin allowlist, `frame-ancestors` configuration, versioned public asset. The embed consumes this same public API, so none of the above is rework.

## Phase 5 — Interviews & Scorecards

Migrations 018–019. Spec: `06b` §3–4.

| # | Task | Model |
|---|---|---|
| T-090 | Migrations 018–019 | Sonnet |
| T-091 | Interview CRUD, timezone handling | Sonnet |
| T-092 | Panelist management + hiring-team trigger | **Opus** |
| T-093 | Slot proposal → candidate token → selection, with lock | **Opus** |
| T-094 | ~~Calendar adapter~~ — **removed, owned by the scheduling team (D-042)** | — |
| T-095 | Scorecard attributes, stage focus attributes | Sonnet |
| T-096 | Scorecard submission, immutability, amendments | Sonnet |
| T-097 | **Anchoring-bias withholding (BR-082)** | **Opus** |
| T-098 | Hire decision at final stage | **Opus** |
| T-099 | Interview suite | **Opus** |

**Gate:**
- [ ] Non-hiring-team user cannot add a panelist (BR-080)
- [ ] Interviewer cannot read peer scores before submitting (BR-082)
- [ ] Submitted scorecard immutable; amendment creates a new row (BR-083)
- [ ] Two slot selections: exactly one succeeds
- [ ] Consumed candidate token returns 410 (BR-018)
- [ ] Interview time correct across a DST boundary

---

## Phase 6 — Agencies & Commission

Migrations 020. Spec: `06b` §5. **The highest-risk phase in the project.**

| # | Task | Model |
|---|---|---|
| T-110 | Migration 020 | Sonnet |
| T-111 | **Agency RLS policies via engagement join** | **Opus** |
| T-112 | Engagement lifecycle | Sonnet |
| T-113 | Job assignment to agencies | Sonnet |
| T-114 | Capability switching (`X-Capability`) | **Opus** |
| T-115 | Agency portal route namespace | **Opus** |
| T-116 | Agency candidate submission | **Opus** |
| T-117 | Cool-off lookback + hire-time attribution | **Opus** |
| T-118 | Non-blocking cool-off report | Sonnet |
| T-119 | Commission dual-access policy | **Opus** |
| T-120 | Agency isolation suite | **Opus** |

**Gate:**
- [ ] Agency session **never** binds a client's company id (BR-072) — assert on the session record itself, not only on responses
- [ ] Agency cannot read client internal jobs, scorecards, notes, or another agency's submissions (BR-074)
- [ ] Terminated engagement removes access immediately
- [ ] Commission: client sees, agency sees, third company sees nothing (BR-007)
- [ ] Earliest qualifying referral wins; one outside the window does not (BR-075)
- [ ] Changing terms after a hire does not alter the existing attribution (BR-076)
- [ ] Dual-capacity company cannot engage itself (BR-071)

Almost entirely Opus. This phase has the most non-standard RLS in the system and the least margin for a plausible-looking mistake.

---

## Phase 7 — Messaging, Audit & Compliance Seams

Migrations 021, 023.

| # | Task | Model |
|---|---|---|
| T-130 | Migrations 021, 023 | Sonnet |
| T-131 | Email templates + rendering | Sonnet |
| T-132 | Message send job, delivery tracking, bounces | Sonnet |
| T-133 | Event-triggered notifications via outbox | Sonnet |
| T-134 | Audit write path, field-level diffs | **Opus** |
| T-135 | **Audit read with masking applied (BR-091)** | **Opus** |
| T-136 | Activity feed | Sonnet |
| T-137 | Erasure request + anonymization procedure | **Opus** |
| T-138 | Webhook delivery, HMAC signing, SSRF guard | **Opus** |

**Gate:**
- [ ] Masked field withheld in audit history for a non-holder (BR-091)
- [ ] Audit unmodifiable — `UPDATE` rejected by grant (BR-096)
- [ ] Anonymization leaves no personal field, retains commission and audit metadata (BR-093)
- [ ] No personal data in any log, trace, job payload, or webhook payload (BR-094)
- [ ] Webhook target in a private IP range rejected (SEC-046)

---

## Phase 8 — AI Seams

Migration 022. **Blocked on O-001.** Structure exists; contract does not.

| # | Task | Model |
|---|---|---|
| T-150 | Migration 022 | Sonnet |
| T-151 | Ranking request event via outbox | Sonnet |
| T-152 | Result ingestion, idempotent on `runId` | **Opus** |
| T-153 | Ranking read endpoints with masking | Sonnet |
| T-154 | Run failure surfacing | Sonnet |

**Gate:**
- [ ] Redelivered result does not double-write (BR-102)
- [ ] Provenance recorded on every row (BR-112)
- [ ] **No path exists for a ranking to change application status** (BR-110)
- [ ] Rankings obey tenant isolation and masking (BR-113)

---

## Phase 9 — Hardening & Launch

| # | Task |
|---|---|
| T-160 | Full isolation suite across every module |
| T-161 | Load test at target volumes (`11` §8) |
| T-162 | Backup and **restore rehearsal** — restore tested, not assumed |
| T-163 | On-prem Compose bundle + skip-version upgrade rehearsal |
| T-164 | Penetration test |
| T-165 | Runbooks, incident response, named owner |
| T-166 | OpenAPI published, Swagger disabled in production |

**Launch gate:**
- [ ] Every `BR-nnn` has a passing citing test
- [ ] Isolation suite green
- [ ] Penetration findings resolved or accepted in writing
- [ ] Restore rehearsed end to end
- [ ] On-prem install rehearsed from a clean machine, plus a skip-version upgrade
- [ ] Availability target agreed (O-009)
- [ ] Retention windows agreed with legal (O-006)

---

## Dependencies

```
Phase 0 ──▶ Phase 1 ──┬──▶ Phase 2 ──┬──▶ Phase 3 ──┬──▶ Phase 4
                      │              │              ├──▶ Phase 5 ──▶ Phase 6
                      │              │              └──▶ Phase 7
                      └──────────────┴──────────────────▶ Phase 8 (needs 2, 3)
```

Phases 4, 5, and 7 can run in parallel after Phase 3 if you have the hands. Phase 6 must follow Phase 5 — commission attribution needs the hire decision.

---

## Working rhythm

1. Read the phase spec and the module LLD.
2. Build with the model indicated per task.
3. Write tests **before or alongside**, not after — a test written after the fact tends to assert what the code does.
4. Run the gate. Do not proceed on a red gate; a skipped isolation test is a decision to ship a leak.
5. Test the module yourself.
6. Changes go to the spec first, then the code. Never the reverse.

**When the agent finds a gap or a contradiction:** it stops and asks (`AGENTS.md` §8). You decide, the decision goes in `00-decisions.md`, then work resumes. This is the single discipline that prevents the correction-on-correction drift that made earlier documents unreliable.
