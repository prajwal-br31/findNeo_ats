# FindNeo — Decision Log

**Status:** Living document. This file wins all conflicts.

When any other document, prior chat transcript, or session extraction disagrees with an `Accepted` decision here, this file is correct and the other document is stale. When an AI coding agent finds an instruction that contradicts an `Accepted` decision here, it must stop and flag it rather than pick one.

**Decision states:** `Accepted` · `Proposed` (awaiting confirmation) · `Open` (undecided, blocking or non-blocking) · `Superseded by D-nnn`

---

## Index

| ID | Decision | State |
|---|---|---|
| D-001 | Shared-database multi-tenancy with RLS | Accepted |
| D-002 | On-premise is a separate deployment target, not a tenancy variant | Accepted |
| D-003 | Two processes: API server + worker, one database | Accepted |
| D-004 | Everything external sits behind an adapter | Accepted |
| D-005 | Platform admins live in `users` with `company_id IS NULL` | Accepted |
| D-006 | Self-service tenant signup | Accepted |
| D-007 | Roles assigned via `user_roles`; `user_departments` is membership only | Accepted |
| D-008 | `job_hiring_team` is the sole source of job-level assignment | Accepted |
| D-009 | Candidates hold a current profile; applications hold an immutable snapshot | Accepted |
| D-010 | One unified `talent_pool_entries` table | Accepted |
| D-011 | Resume: one current at profile level, one frozen copy per application | Accepted |
| D-012 | Configurable cap on concurrent applications, enforced by trigger | Accepted |
| D-013 | Cool-off is resolved at hire time only; never blocks submission | Accepted |
| D-014 | Agency portal never switches RLS tenant context | Accepted |
| D-015 | Candidates never authenticate | Accepted |
| D-016 | Job queue is pg-boss | Accepted |
| D-017 | In-process caching only at launch | Accepted |
| D-018 | Stack: PG18 / Node 22 / Fastify / TypeBox / Drizzle | Accepted |
| D-019 | ~~No BFF tier~~ | **Superseded by D-036** |
| D-020 | Token transport: memory + httpOnly refresh cookie | Accepted |
| D-021 | RFC 7807 errors with `code` and `fields[]` | Accepted |
| D-022 | Uploads go through the API, not presigned URLs | Accepted |
| D-023 | Cursor pagination only | Accepted |
| D-024 | No realtime transport in v1 | Accepted |
| D-025 | Field masking is server-side only | Accepted |
| D-026 | Career site runs under a separate Postgres role | Accepted |
| D-027 | Compliance seams now, compliance workflows later | Accepted |
| D-028 | Smart forms: typed columns for logic, JSONB for custom fields | Accepted |
| D-029 | AI integration seams built now, AI logic later | Accepted |
| D-030 | Offers module is Phase 2 | Accepted |
| D-031 | Transactional outbox for all cross-service events | Accepted |
| D-032 | `uuidv7()` primary keys | Accepted |
| D-033 | Non-destructive application transfer | Accepted |
| D-034 | GDPR erasure by anonymization, never hard delete | Accepted |
| D-035 | Commission attribution snapshotted at hire time | Accepted |
| D-036 | Client-adaptation BFF layer, module-first | Accepted |
| D-037 | Four-layer architecture: BFF / Application / Domain / Infrastructure | Accepted |
| D-038 | Pragmatic domain layer — rich where invariants are rich | Accepted |
| D-039 | Worker fleet: six logical queue domains, independently scalable | Accepted |
| D-040 | Tenant fairness enforced in the queue adapter | Accepted |
| D-041 | Scale posture: shard-ready, not sharded | Accepted |
| D-042 | Calendar and interview scheduling owned by another team | Accepted |
| D-043 | Career site: hosted page in v1, embed widget Phase 2 | Accepted |
| D-044 | Unit of Work port — transactions without leaking the ORM upward | Accepted |
| D-045 | Version policy: dev tooling tracks current, runtime stays conservative | Accepted |
| D-046 | Local development and tests run against native PostgreSQL, not Testcontainers | Accepted |
| D-047 | RLS policy uses `nullif` on the tenant GUC; migrator holds BYPASSRLS | Accepted |
| D-048 | Test-only `findneo_test_runner` role holds CREATEDB; T-011 splits | Accepted |
| D-049 | User email is globally unique, not tenant-scoped | Accepted |
| D-050 | Owner role granted at MFA enrolment, not at signup | Accepted |

---

## Foundation

### D-001 — Shared-database multi-tenancy with RLS
**Accepted.**

One database, one schema, every tenant-scoped table carries `company_id`, isolation enforced by PostgreSQL Row-Level Security with `FORCE ROW LEVEL SECURITY` enabled.

**Why:** Silo (database-per-tenant) multiplies migration and operational cost by tenant count. Pool + RLS gives database-enforced isolation that survives a forgotten `WHERE` clause in application code, which application-layer filtering alone does not.

**Consequences:**
- Every request binds tenant context inside one explicit transaction via parameterised `set_config('app.current_company_id', $1, true)`. Never string interpolation. Never `SET` without `LOCAL`. Never outside a transaction.
- Every tenant-scoped table gets a composite index with `company_id` as the leading column.
- Every unique constraint that would be global becomes composite with `company_id`.
- Isolation is enforced **twice**: RLS at the database, plus an explicit scope check in the repository layer. Defence in depth, because RLS misconfiguration is silent.
- Requires a dedicated non-superuser application role. Table owners bypass RLS without `FORCE`.

**Known exception:** `commission_attributions` has no single owning company — both the hiring org and the sourcing agency have a legitimate claim. Its policy is an OR across two derived paths. This is the only permitted deviation from the standard pattern and must be individually tested.

---

### D-002 — On-premise is a separate deployment target, not a tenancy variant
**Accepted.**

The hosted SaaS product runs the pool model (D-001). An on-premise customer receives a complete, isolated stack — their own database, their own API and worker processes, their own storage. It is the same software with a different configuration, not a different tenancy mode.

**Why:** Trying to serve on-premise as "a tenant that happens to be alone" leaks hosted-only assumptions into the codebase and creates a second isolation model to reason about.

**Consequences:**
- Every external dependency must have an implementation that a self-hosting customer can run without a cloud account (D-004).
- Nothing may require a managed-only service. No SQS, no DynamoDB, no cloud-specific secret store as the only option.
- The RLS code path stays identical on-premise, running with a single company. Do not add a "skip RLS when self-hosted" branch — that branch will eventually run in production.
- Telemetry must be self-hostable and must never egress from customer premises by default.

---

### D-003 — Two processes: API server + worker, one database
**Accepted.**

`apps/api` serves HTTP. `apps/worker` consumes pg-boss jobs. Both connect to the same PostgreSQL database and share the same domain and repository code.

**Consequences:**
- Domain services must not depend on HTTP request objects. A service invoked from a worker has no `req`.
- Tenant context binding is a shared concern, not middleware-only. The worker binds `app.current_company_id` from the job payload with exactly the same helper the API uses.
- A job payload must always carry `companyId` and the acting user, or the worker cannot bind context or attribute audit entries.

---

### D-004 — Everything external sits behind an adapter
**Accepted.**

Object storage, email, the job queue, and the cache are each accessed only through an internal interface. No business logic imports `pg-boss`, an S3 client, an SMTP client, or a cache library directly.

**Why:** Forced by D-002. It also makes every one of these trivially fakeable in tests.

**Required adapters and their v1 implementations:**

| Port | Hosted | On-premise |
|---|---|---|
| `StoragePort` | S3 | Filesystem / MinIO |
| `MailPort` | Provider API | SMTP |
| `QueuePort` | pg-boss | pg-boss |
| `CachePort` | In-process LRU | In-process LRU |
| `ClockPort` | System | System |

`ClockPort` is included deliberately: cool-off windows, token expiry, and retention clocks are all time-dependent business rules, and they must be testable without sleeping.

---

## Identity, tenancy, access

### D-005 — Platform admins live in `users` with `company_id IS NULL`
**Accepted.** Reconciles the merged-model schema with the isolation requirement.

Platform staff are `users` rows with a NULL company. They are nonetheless structurally isolated:

- Separate login endpoint with its own stricter rate limit.
- MFA mandatory, enforced at the database level.
- A session for a platform admin never carries a tenant `active_company_id` into ordinary tenant queries.
- Every tenant RLS policy is written so a NULL-company row can never satisfy it.
- Access to tenant data is an explicit, time-boxed, fully audited impersonation action — never ambient.

**Consequences:** `users.email` needs two partial unique indexes — `(company_id, email)` where company is not null, `(email)` where it is null. Every `created_by` and audit-actor column must tolerate a NULL-company actor.

---

### D-006 — Self-service tenant signup
**Accepted.** Supersedes the PRD's admin-provisioned flow.

A company signs itself up. The first user becomes that company's Super Admin (tenant owner). MFA is mandatory for that account, enforced by a database trigger that blocks owner assignment unless `mfa_enabled = true`.

**Consequences:** There is a public, unauthenticated signup surface. It needs email verification before the tenant becomes usable, rate limiting, and disposable-domain handling.

**Terminology, fixed:** *System Admin* = internal FindNeo staff (D-005). *Super Admin* = the customer's own tenant owner. These have been confused before; they are never interchangeable.

---

### D-007 — Roles assigned via `user_roles`; `user_departments` is membership only
**Accepted.** Supersedes the earlier `user_departments.role_id` mechanism.

`user_roles` has a surrogate primary key, `company_id`, `role_id`, nullable `department_id`, and partial unique indexes rather than a composite primary key. `roles.scope` gains `department` alongside `platform`, `company`, and `job`.

**Why:** Role-via-department-membership cannot represent a Super Admin (tenant-wide, no department) or an agency user (no department in the client org), and it caps a user at one role per department. The scope vocabulary already implied non-departmental roles existed.

**Consequences:** Any document or transcript stating that roles come from `user_departments.role_id` is stale. `user_departments` keeps `is_primary` for defaulting only — never for access decisions.

---

### D-008 — `job_hiring_team` is the sole source of job-level assignment
**Accepted.**

`user_roles.job_id` exists in the schema but is not the mechanism for "who works on this job." Job membership is `job_hiring_team(job_id, user_id, team_role)`, full stop.

**Why:** Two systems answering the same question is how authorization bugs are born.

**Consequences:** Guest panelists covering a single interview are added to `interview_panelists` without `job_hiring_team` membership. Only an existing `job_hiring_team` member may add a panelist, enforced by trigger.

---

### D-014 — Agency portal never switches RLS tenant context
**Accepted.** Correctness fix, not a preference.

An agency user's session stays scoped to the agency's own company. Access to a client's data flows through an explicit join to `agency_engagements` with its own policies. The session never rebinds `app.current_company_id` to the client company.

**Why:** If an agency session bound the client's tenant id, a single tenant-id predicate would expose the client's internal jobs, other agencies' candidates, and internal feedback. Tenant identity and delegated access are different things and must not share one mechanism.

**Consequences:** Agency-facing endpoints live under their own route namespace with their own policy set. They are never the same handler as the internal endpoint with a permission check bolted on.

---

### D-015 — Candidates never authenticate
**Accepted.**

No candidate account, password, or session. Every candidate-facing action — slot selection, document upload, withdrawal — uses a single-purpose, expiring, hashed token bound to one application and one action type.

**Consequences:** Tokens are stored hashed, are single-use where the action is state-changing, and carry no ambient authority beyond the action they encode.

---

## Candidates and applications

### D-009 — Candidates hold a current profile; applications hold an immutable snapshot
**Accepted.** Supersedes the earlier "candidates holds almost nothing" model.

`candidates` carries a current, mutable profile: name, phone, current title, experience, education, location, current resume pointer. `applications` continues to carry a full frozen snapshot captured at submission and never updated afterwards.

**Why:** Duplicate detection, Talent Rediscovery, and prompt-based candidate search all need a current profile. Frozen-per-application audit integrity needs a snapshot. These are not in conflict; the previous model simply gave up one to get the other.

**Consequences:** Both properties are preserved and neither is derived from the other. A candidate's stated experience may legitimately differ between two applications at the same company — that is correct behaviour, not a bug.

---

### D-010 — One unified `talent_pool_entries` table
**Accepted.** Supersedes `org_candidate_pool` and `agency_candidate_pool`.

`talent_pool_entries(owner_company_id, candidate_id, status, source, notes, added_by, created_at)` — membership and provenance only, no duplicated profile fields.

**Why:** Two tables differing only by owner column is duplication. Because agencies are companies, an agency's pool people are `candidates` rows owned by the agency, and the org/agency privacy boundary falls out of RLS for free rather than needing a second table and a second policy set.

**Consequences:** When an agency submits a candidate to a client, a candidate row is created or deduped by email **in the client's tenant** and the snapshot is written there. The agency's own candidate row remains theirs. An organisation cannot see an agency's pool — enforced by ordinary tenant RLS, not special-case logic.

---

### D-011 — Resume: one current at profile level, one frozen copy per application
**Accepted.**

`candidate_resumes` serves both roles in one table. Rows with `application_id IS NULL` are the profile-level current resume — updatable, one current per candidate. At submission the file is **copied to a new storage path** and a new immutable row is written with `application_id` set.

**Why:** A pool resume being updated must never alter what a hiring team already evaluated.

**Consequences:** `applications.resume_url` is deleted — it was a third representation of the same fact. Storage costs a duplicate object per application; this is accepted and is small. Copy happens in the worker, not inline in the request.

---

### D-012 — Configurable cap on concurrent applications, enforced by trigger
**Accepted.** Supersedes the hard one-active-application unique index.

Each company configures via `settings`: restrict to 1 (default), or allow up to N with N capped at 10.

**Why:** A unique index cannot express "at most N."

**Consequences:**
- Enforced by a database trigger, not application code alone, and not a unique index.
- The trigger must take a row lock on the candidate to close the concurrent-submission race. Two simultaneous submissions must not both pass the count check.
- `UNIQUE(job_id, candidate_id)` is scoped to active status only, so a rejected candidate may re-apply to the same job later.

---

### D-013 — Cool-off is resolved at hire time only; never blocks submission
**Accepted.**

No submission-time gate. At hire, a lookback across the candidate's full application history finds the earliest agency-sourced application inside the applicable cool-off window and attributes commission to it.

**Why:** Hires are rare relative to applications. Checking at hire time is correct and cheap; checking on every submission is expensive and would surface one agency's commercial position to another.

**Consequences:** A non-blocking **reporting view** surfaces "this candidate sits inside another agency's cool-off window." Informational only. Requires the index on `applications (candidate_id, company_id, created_at) WHERE agency_company_id IS NOT NULL`, and requires that rejected applications are never hard-deleted (D-034).

---

### D-033 — Non-destructive application transfer
**Accepted.** Deliberately differs from Greenhouse, which transfers destructively.

The source application is marked `transferred` and retains all interview and feedback history permanently. A new application is created with profile fields copied forward, except `expected_ctc` which is left blank. The new job's hiring team does not inherit visibility of the old job's feedback.

---

### D-035 — Commission attribution snapshotted at hire time
**Accepted.**

`commission_attributions` rows are written only as a side effect of the hire action, never computed live and never created directly through the API. The row snapshots the cool-off term and commission rate in effect at that moment.

**Why:** Contract terms change. A payout computed live would silently change retroactively.

**Fix applied:** `attributed_agency_id` references `companies.id`. The standalone `agencies` table no longer exists post-merge.

---

## Platform and infrastructure

### D-016 — Job queue is pg-boss
**Accepted.** Supersedes BullMQ.

**Why:** (a) Zero new infrastructure for on-premise customers, where Redis would be one more service every self-hosting customer must install, secure, and maintain. (b) Transactional enqueue — the job table lives in the same database, so a job can be enqueued in the *same transaction* as the record that triggers it. Redis cannot guarantee that; it produces the classic "row committed, job lost" and "job fired, row rolled back" failure pairs.

Throughput ceiling is a non-concern: volume is bounded by human hiring activity.

**Consequences:** Accessed only through `QueuePort` (D-004). A future swap to BullMQ is an adapter change.

---

### D-017 — In-process caching only at launch
**Accepted.**

A simple in-process LRU for read-heavy, rarely-changing lookups: `role_permissions`, `field_visibility_rules`, form template definitions, the permission catalog.

**Accepted trade-off:** With multiple instances behind a load balancer each keeps its own copy, so a change may take minutes to propagate. Fine for values that change monthly.

**Consequences:** Cache keys must include `company_id`. A shared process caching many tenants' entries makes an unkeyed cache a cross-tenant leak. Accessed only through `CachePort`. Redis is a hosted-product decision if load ever demands it, never a requirement pushed onto on-premise customers.

---

### D-018 — Stack: PG18 / Node 22 / Fastify / TypeBox / Drizzle
**Accepted.**

- **PostgreSQL 18.** Also unlocks D-032.
- **Node 22 LTS.**
- **Fastify** — mature schema-driven validation and serialization, low overhead.
- **TypeBox** — emits JSON Schema natively, so static route validation, OpenAPI/Swagger generation, and dynamic smart-form validation (D-028) all run through one Ajv pipeline instead of three parallel systems.
- **Drizzle** — gives genuine transaction-scoped clients, which is precisely what RLS context binding requires, and emits readable SQL.
- **Vitest + Testcontainers** — real PostgreSQL in tests. RLS policies cannot be meaningfully tested against a mock.

**Rejected: Prisma.** Its connection abstraction fights transaction-bound session state. The commonly circulated workaround wraps every operation in its own transaction, which destroys multi-statement transactions and throughput. The version of that workaround in the project's own RBAC appendix additionally interpolated the tenant id into raw SQL — an injection vector. Recorded here so it is not reintroduced.

---

### D-032 — `uuidv7()` primary keys
**Accepted.**

Use PostgreSQL 18's native `uuidv7()` rather than random v4.

**Why:** Time-ordered UUIDs preserve index locality. Under D-001 every hot index leads with `company_id` and is followed by a key or timestamp; random v4 primary keys scatter inserts across the index and inflate write amplification. v7 keeps recent rows physically together, which is also the access pattern for nearly every list query in this product.

**Note:** v7 encodes creation time. Do not use primary keys in contexts where that leaks meaningful information externally.

---

### D-031 — Transactional outbox for all cross-service events
**Accepted.**

Events crossing a service boundary — to the AI services, to webhooks, to the notification pipeline — are written to an `outbox` table in the same transaction as the state change, then relayed by the worker.

**Why:** Without it, "candidate hired" can commit while the notification is lost, or fire while the transaction rolls back. Retrofitting an outbox after these paths exist means revisiting every write.

**Consequences:** Relay is at-least-once. Every consumer must be idempotent. Every event carries an id, `companyId`, type, version, and occurrence time.

---

## API and client contract

### D-019 — No BFF tier
**Superseded by D-036.**

Original reasoning: a BFF duplicates the auth surface, adds a fourth process on-premise, and shapes the API around one of three consumers.

**Why it was overturned:** the original decision optimised for v1 simplicity and did not weigh the mobile client that is now planned. A client-adaptation boundary is far cheaper to establish before three consumers exist than to retrofit afterwards. D-036 preserves the parts of this reasoning that still hold — no duplicated auth, no extra on-premise process — by making the BFF a module rather than a service.

---

### D-036 — Client-adaptation BFF layer, module-first
**Accepted.** Supersedes D-019.

A BFF layer exists from the start. Its only job is **client adaptation**: response shaping, aggregating several application operations into one call, reducing round trips, client-specific pagination and filtering, client-specific caching, and session/cookie adaptation.

**It is implemented as a module inside the API deployable**, not a separate process:

```
src/bff/web/          ← route namespace /bff/web/*
src/bff/mobile/       ← added later, same pattern
```

**Why module rather than service, initially:** a module gets every benefit the boundary exists for — isolated client concerns, business logic below it, a Mobile BFF addable without duplication — at zero on-premise cost, with one auth surface and no added hop. Because the boundary is enforced by the linter rather than by the network, extraction to a separate deployable later is moving a folder.

**Extract to a separate process when** a concrete driver appears: independent deploy cadence, a client team shipping on its own schedule, or divergent scaling. Not before.

**Hard constraints, enforced by `eslint-plugin-boundaries`:**
- The BFF may import **application services only**. Never a repository, never a domain entity, never the database client.
- No business rule, authorization rule, workflow, or use case in the BFF. If a rule appears there, it is in the wrong layer.
- The BFF may not bypass the application layer for any reason.
- No client-specific logic below the BFF. The application layer never knows which client is calling.

**`/v1/*` remains the canonical API** and stays a first-class, fully supported surface — it serves integrations, the career site embed, and on-premise customers with their own tooling. The BFF is additive, never a replacement, and `/v1/*` is never allowed to degrade into "the thing behind the BFF."

---

### D-037 — Four-layer architecture
**Accepted.**

```
Client (Web, later Mobile)
  ↓
BFF               client adaptation only
  ↓
Application       use cases, orchestration, transactions, authorization decisions
  ↓
Domain            entities, invariants, business rules
  ↓
Infrastructure    PostgreSQL + Drizzle · pg-boss · storage · mail · AI · integrations
```

Dependencies point downward only. The domain layer depends on nothing — no ORM, no framework, no adapter. Infrastructure implements interfaces the domain and application layers declare.

**Mapping from the previous three-layer model:** what was called a "service" is now split — orchestration and transaction boundaries stay in the application layer, invariants move to the domain layer. Repositories move into infrastructure. Controllers become thin adapters under the BFF or under `/v1/*`.

---

### D-038 — Pragmatic domain layer
**Accepted.**

A rich domain layer where invariants are rich; plain application services elsewhere.

**Full domain modelling (entities with enforced invariants):**
- Application lifecycle and stage state machine
- Commission attribution and cool-off resolution
- Permission resolution and effective access
- Agency engagement and access derivation

**Application services only, no entity ceremony:** departments, skills, form templates, hiring team membership, and other CRUD.

**Why not uniform DDD:** modelling `PATCH /v1/departments/{id}` as an aggregate is pure overhead, and overhead applied uniformly is how teams stop following an architecture. The four areas above carry the rules that are genuinely hard to get right and genuinely expensive to get wrong; they earn the ceremony. The rest does not.

**Test for promoting something into the domain layer:** does it have an invariant that must hold across more than one field, or a state machine with illegal transitions? If yes, model it. If it is validation plus persistence, it is not domain logic.

---

### D-039 — Worker fleet: six logical queue domains
**Accepted.** Supersedes any implication that one worker handles everything.

pg-boss is the asynchronous **workflow layer**, not merely a transactional side-effect mechanism.

```
workers/
├── communication/    email, SMS, push, reminders
├── ai/               parsing, embeddings, ranking, transcription
├── documents/        resume copy, exports, generation
├── integrations/     webhooks, calendar sync, external systems
├── recruitment/      pipeline automation, SLA, aging
└── system/           cleanup, retention, reports, maintenance
```

Each domain is a **separate queue with its own worker pool**, independently deployable and independently scalable.

**Per-domain policy** — concurrency, priority, retry and backoff, rate limit, timeout — is declared in configuration, not hard-coded per job.

**Why the split matters:** AI workloads are slow, bursty, and expensive. A single pool means a bulk embedding run starves interview reminders. Domain separation is the only reason a critical notification stays fast under AI load.

**Consequences:**
- The worker deployable takes a domain argument: one process per domain in production, all domains in one process for local development.
- A job is registered to exactly one domain. Cross-domain chaining goes through the outbox, never a direct call.
- `queue_backlog_size` and `queue_job_duration_seconds` are labelled by domain.

---

### D-040 — Tenant fairness enforced in the queue adapter
**Accepted.**

No per-tenant queues — at scale that is an unbounded number of queues, and pg-boss is not built for it. Instead every job payload carries `companyId`, and the queue adapter enforces a per-tenant in-flight cap within each domain.

**Mechanism:** `QueuePort`'s fetch path applies a per-tenant concurrency cap rather than taking the next N jobs by age. A tenant already at its cap is skipped and the next tenant's work is taken.

**This is not pg-boss default behaviour.** It requires a custom claim query against pg-boss's job table — which is **not a public API**. It lives entirely in the adapter, so no job handler and no business logic knows it exists.

**Required guards, because an internal dependency that fails silently is the worst kind:**

1. **Exact version pin** on pg-boss. No range, ever (D-045 does not relax this — pg-boss is a runtime dependency).
2. **A schema-shape control-integrity assertion** (`11` §3a) that reads pg-boss's job table definition and fails CI if the columns the claim query depends on change name, type, or nullability. An upgrade must break the build, not the fairness guarantee.
3. **A behavioural assertion** that one tenant flooding a domain does not stall another tenant's jobs in that same domain — the Phase 0 gate item. This is the test that proves fairness is actually working, independent of how it is implemented.
4. **Isolation in the adapter** such that the claim strategy can be swapped without touching a handler.

**Documented fallback if the claim query proves too fragile across versions:** hash-partition each domain into N sub-queues by `companyId` (`ai.0` … `ai.7`), routing on hash. Uses only pg-boss's public API. A flooding tenant then occupies one partition rather than the whole domain. It is weaker — tenants sharing a partition can still contend, and N is a fixed guess — but it degrades gracefully and depends on nothing internal.

Take the claim query first, with guards 1–4. Fall back to partitioning only if the guards prove unsustainable, and record that as a new decision rather than a quiet substitution.

**Implementation deferred to Phase 9 (T-159a).** The failure it prevents — one tenant's bulk import occupying every worker slot — requires many tenants under real load, which does not exist before launch. Building it in Phase 0 spends the project's most expensive engineering on a problem that cannot occur yet.

**What Phase 0 must still do, because these are not cheap to retrofit:**
- Every job payload carries `companyId` (ER-042a). Non-negotiable; fairness of any shape needs it.
- `QueuePort`'s interface must **not assume one queue per domain**, so both the claim-query and hash-partition strategies remain available without touching enqueue sites.

With those two in place, adding fairness later is contained to the adapter. Without them it is a change across every enqueue call in the codebase.

**Before launch this becomes mandatory.** It is a launch-gate item in `13-delivery-plan.md` Phase 9, not an optional hardening step — one tenant able to halt every other tenant's notifications is a full outage caused by ordinary use.

---

### D-041 — Scale posture: shard-ready, not sharded
**Accepted.**

The architecture must not preclude horizontal partitioning at very large tenant counts. It does **not** build sharding now — premature sharding costs enormously and buys nothing at current volume.

**Required now (cheap, and expensive to retrofit):**
- `company_id` leads every tenant index and is the de facto partition key.
- No query joins across tenants. No aggregate spans tenants.
- Every job payload carries `companyId` (D-040).
- The queue sits behind `QueuePort`, so a workload can move to different infrastructure without touching business logic.
- Database access sits behind repositories, so a shard-routing layer inserts in one place.
- No global auto-increment identifiers. `uuidv7()` throughout (D-032).

**Explicitly not now:** shard routing, a tenant-location registry, cross-shard query planning, Redis, Kafka.

**Known problem at shard time — recorded, not solved.** `agency_engagements` and `commission_attributions` reference **two** companies. Under `company_id` sharding, a client and its agency may land on different shards, and neither table has a natural home. Two viable answers when it becomes real: co-locate engaged companies on one shard (simple, constrains placement), or keep a small globally-replicated relationship store (flexible, adds a consistency surface). **This is the only place the current design does not shard cleanly.** It is not a reason to change anything now.

---

### D-042 — Calendar and interview scheduling owned by another team
**Accepted.**

Calendar integration, slot proposal, and interview scheduling are being built by a separate team. Out of scope for the ATS core.

**Retained here:** the `interviews`, `interview_panelists`, `interview_slots`, and `candidate_action_tokens` tables, panelist authority rules, scorecards, and stage decisions. The ATS owns *who is on the panel and what they concluded*; the other team owns *when it happens and how the calendar knows*.

**Seam:** the scheduling service reads and writes interview scheduling fields through the API, or emits events the ATS consumes. **Open (O-014)** — needs the same contract treatment as O-001.

**Consequences:** T-094 (calendar adapter) is removed from Phase 5. `calendar_connections` and OAuth token storage are not in this schema and must not be added here.

---

### D-043 — Career site: hosted page in v1, embed widget in Phase 2
**Accepted.** Resolves the subdomain-versus-slug question and scopes the embed.

**v1 — hosted career page.** FindNeo serves a public job listing and application flow at a FindNeo-owned URL, addressed by company slug. No per-tenant subdomains, no custom domains: those need wildcard DNS, wildcard TLS, and per-domain certificate management for a product that has not launched.

**Phase 2 — embeddable widget.** A small script rendering a tenant's openings inside their own site, Workday-style, with an iframe fallback. Deferred deliberately: it adds a cross-origin write surface with no same-origin protection, a per-company allowlist of embedding origins for `frame-ancestors`, and a versioned public asset to maintain — none of which is needed to let candidates apply.

**Why deferring costs nothing.** The embed and the hosted page consume the **same public API**. The `/v1/public/{companySlug}/*` contract, the `findneo_public` database role, the public RLS policies, and the anti-abuse controls are all built in v1 and are exactly what the embed will use. Phase 2 adds a rendering surface, not a backend.

**Kept minimal in v1:** CORS on public routes is restricted to the FindNeo career-page origin. The per-company embedding-origin allowlist is **not** built — it arrives with the embed. No `frame-ancestors` allowlist table, no public script asset, no versioned CDN bundle.

**Consequences:** Phase 4 is smaller than originally scoped. The tenant onboarding flow must surface the hosted career page URL, since in v1 that is the only place candidates can apply.

---

### D-044 — Unit of Work port
**Accepted.** Resolves the tension between ER-003 (application services own transaction boundaries) and ER-006 (no database access outside a repository).

An application service must be able to say "run these repository calls in one transaction with tenant context bound" without importing the ORM.

**Mechanism:**
- `UnitOfWorkPort` and an **opaque** `TxScope` type are declared in `shared/` — not in `platform/`.
- `platform/db` is the only code that knows `TxScope` is a Drizzle transaction client.
- Application services depend on `shared/`, call `uow.withTenant(companyId, fn)`, and receive a `TxScope` they pass to repositories but never dereference.
- Repositories, in `infrastructure/`, accept `TxScope` and unwrap it.

```ts
// shared/ports/unit-of-work.ts
export type TxScope = { readonly __brand: 'TxScope' };
export interface UnitOfWorkPort {
  withTenant<T>(companyId: CompanyId, fn: (tx: TxScope) => Promise<T>): Promise<T>;
  withoutTenant<T>(fn: (tx: TxScope) => Promise<T>): Promise<T>;  // signup, platform ops
}
```

**Consequences:**
- `application → platform/db` stays **denied** in the boundaries config. The conflict was in the rules, not the config.
- `platform/db` additionally carries an `entry-point` restriction exposing only its port implementation, so infrastructure cannot reach past it either.
- The container in `bootstrap/` wires the implementation. Bootstrap may import everything; nothing else may.
- Tests fake `UnitOfWorkPort` trivially, which makes application services testable without a database while repositories keep their real-Postgres tests.

**Rejected: AsyncLocalStorage.** It works and reads more cleanly, but it makes "am I inside a transaction with tenant context bound?" implicit. That is the one question in this codebase that must never be implicit, and an ALS miss fails silently rather than loudly.

---

### D-045 — Version policy
**Accepted.** Replaces blanket major-version pinning.

| Class | Policy |
|---|---|
| Dev tooling (linters, formatters, test runners, hooks) | **Latest stable at install time.** Exact-pinned, with the install date recorded |
| Runtime dependencies | Conservative. A major upgrade is a deliberate, reviewed change |
| Language and framework (TypeScript, Node, Fastify, Drizzle) | Latest stable **minus ecosystem risk** — verify the toolchain around it supports the version before moving |

**Why:** hard-coding a major version in a specification guarantees drift, and being two majors behind on a linter means missing rules that exist to catch the mistakes this architecture invites. Dev tooling carries near-zero production risk, so it should track current.

**Standing exception recorded now:** TypeScript stays on latest 5.x until `typescript-eslint` and Drizzle both officially support TypeScript 7. The risk is not the compiler; it is type inference in the two tools the whole codebase depends on. Re-evaluate at the end of Phase 1 and propose a decision entry.

**Exact pinning still applies.** No `^`, no `~`, lockfile committed, `--frozen-lockfile` in CI. "Latest at install" means resolved once, recorded, and changed deliberately.

---

### D-046 — Local development and tests run against native PostgreSQL
**Accepted.** Amends `11-testing-strategy.md` §2 for the local environment only.

Docker is not available on the primary development machine. Both the application and the test suite run against a natively installed PostgreSQL 18.

**Required, not optional:**
- `DATABASE_URL` and `DATABASE_URL_TEST` are **required config values with no defaults**. A missing value fails at startup (SEC-060).
- A **database-name guard** rejects any test run whose target database name does not end in `_test`, checked before any DDL. The harness drops and recreates databases; a silent fallback to the development connection destroys work.
- The template-database restore pattern from `11-testing-strategy.md` §2 is unchanged — it works identically against a plain server.
- **Two test connections are required**, not one: an owner role and the application role. `FORCE ROW LEVEL SECURITY` is only meaningful against a role that owns nothing, and the owner connection is what proves seeded rows exist — otherwise a zero-row result passes vacuously whether isolation works or not.

**Trade-off accepted:** no guaranteed clean state between runs. A test leaving residue can pass on leftover state and fail elsewhere. Manageable with one developer; revisit if the team grows.

**CI is unaffected** — GitHub Actions provides PostgreSQL as a service container. Testcontainers remains the specified approach for any environment where a container runtime exists; this decision governs the local machine.

**Migration 001 requires a superuser once per fresh install.** `findneo_migrator` is `NOCREATEROLE` by design, and `CREATE EXTENSION citext` is not a trusted extension. Every block in migration 001 is guarded and idempotent, so re-running is a no-op.

---

### D-047 — RLS policy corrections
**Accepted.** Two corrections to the canonical pattern, both found by executing the Phase 0 concurrency tests against a real pooled connection.

**(a) `nullif` on the tenant GUC.** A transaction-local GUC reverts to the empty string at transaction end, not to undefined. `current_setting(…, true)` therefore returns `''` — not NULL — on any connection that has previously served a tenant, and `''::uuid` raises. The policy predicate is now:

```sql
company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
```

Without it, an untenanted query on a warm pool is a 500 rather than zero rows. It fails closed, but SEC-003 permits exactly one failure direction and this was a third.

**Consequence for testing:** the concurrency harness must run more transactions than the pool holds connections. A single-connection test cannot surface this, and it would have stayed invisible until Phase 1 load.

**(b) `findneo_migrator` holds `BYPASSRLS`.** Under `FORCE`, the table owner is subject to policies, and no policy names the migrator — so seeding in migration 015 would be denied on tables it owns.

**Why this is not a weakening:** the migrator owns the tables and can `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` at will. Withholding `BYPASSRLS` grants nothing it cannot grant itself; it only costs a per-table policy someone eventually forgets. The real control is credential separation — `DATABASE_URL_MIGRATOR` is read by nothing that serves traffic.

**Rejected alternatives:** moving seeds before migration 013 (fragile — every future data migration hits the same wall); per-table migrator policies (BYPASSRLS with more surface to get wrong).

**Compensating assertions, required in the isolation suite:** `findneo_app` and `findneo_public` do not hold `BYPASSRLS`, asserted against `pg_roles`; every `company_id` table has RLS enabled and forced; no application config schema can hold the migrator connection string.

---

### D-048 — Test harness privileges and scope
**Accepted.**

**(a) A fourth, test-only role.** Template cloning needs `CREATEDB`. `findneo_migrator` is `NOCREATEDB` by design, and unlike `BYPASSRLS` (D-047b) this is **not** self-grantable by an owner — so that decision's reasoning does not transfer.

`findneo_test_runner` holds `CREATEDB` and exists only in development and CI provisioning. **It owns the template database and every per-test clone outright.**

**The template must be owned by the runner, not only the clones.** PostgreSQL requires the creating role to own a database in order to copy it as a `TEMPLATE`. Provisioning therefore includes:

```sql
ALTER DATABASE findneo_test OWNER TO findneo_test_runner;
```

Table ownership inside the database is unaffected — migrations create the tables as `findneo_migrator`, so `FORCE ROW LEVEL SECURITY` behaves exactly as in production. Only database ownership moves.

**Amended.** An earlier draft said the migrator owned the clones. That was incidental wording, and it was wrong to state: PostgreSQL requires the creating role to be a *member* of the owning role to assign ownership elsewhere, so it forced a `GRANT findneo_migrator TO findneo_test_runner`. That is strictly more privilege than anything needs.

Database ownership and table ownership are separate. **Table** ownership inside the clone stays with `findneo_migrator`, and table ownership is what makes `FORCE ROW LEVEL SECURITY` behave as it does in production. Database ownership affects nothing the tests depend on.

**Isolation suite assertions:**
- No production role holds `CREATEDB`.
- **No role is a member of `findneo_migrator`** — read from `pg_has_role`, never assumed. Membership would let a serving role reach `BYPASSRLS` via `SET ROLE`, which is the single capability the tenant model depends on withholding.

**Rejected: transaction-rollback isolation.** Faster and privilege-free, but the concurrency tests commit — and those tests have already caught two real defects. A harness that cannot test committed state cannot test what most needs testing.

**(b) T-011 splits.** The tables `seedTwoTenants` needs do not exist until Phase 1 migrations 002–012.

- **T-011 (Phase 0):** harness machinery — migrate the test database, build the template, clone per test, connection-pool discipline. Provable against the `rls_probe` fixture.
- **T-020a (Phase 1):** the `seedTwoTenants` body, landing with the tables.

`seedTwoTenants` **throws** until then. It must never return empty objects: a fixture that seeds nothing makes every leak test pass vacuously, because alpha cannot see beta's data when beta has none. Declaring the gap is correct; a green suite that proves nothing is not.

---

### D-049 — User email is globally unique
**Accepted.** Amends `06-data-model.md` §3. Resolves O-011.

One partial unique index on `users (email) WHERE anonymized_at IS NULL`, replacing the two tenant-scoped and platform-scoped indexes.

**Why:** login is email-first at one fixed domain (D-006). A tenant-scoped index permits the same address in two companies, which makes the login lookup ambiguous with no way to resolve it short of asking for a company — and D-006's superseded table already rejected subdomain and tenant-first login.

**Accepted limitation:** one person cannot hold accounts at two companies under one address. Given BR-005, that is close to the intended model already.

**Upgrade path if it bites:** a second login step disambiguating **after** password verification. Never before — listing an address's companies pre-authentication is an enumeration oracle (SEC-015).

**Also resolves O-011:** a platform-staff address cannot collide with a tenant user's, because there is now one index over both.

---

### D-050 — Owner role granted at MFA enrolment, not at signup
**Accepted.** Resolves the conflict between `trg_owner_requires_mfa` (migration 014) and signup step (e).

The trigger blocks granting `super_admin` to a user without MFA. Signup cannot grant it, because the founding owner has not enrolled.

**The trigger is not exempted.** An exempted security trigger is a trigger with a hole, and the founding grant is the one that matters most — it is the account that can reassign every permission in the tenant.

**The grant moves instead:**

```
signup       → company 'pending_verification', user 'pending',
                owner_user_id set, no role grant
verify-email → user 'active'
enable-mfa   → ONE transaction: mfa_enabled = true,
                grant super_admin, company → 'active'
```

A company holds an `owner_user_id` with no role-holder until enrolment completes. Safe, because the company is not `active` and no tenant route will serve it.

**Rejected: exempting the founding assignment.** It would make BR-011 conditional at exactly the point it is most load-bearing, and the exemption would be permanent surface for a one-time need.

---

## Open items

| ID | Item | Blocks |
|---|---|---|
| O-001 | Resume-ranker contract — request/response shape, poll vs callback | AI seam finalisation; not ATS core |
| O-002 | Service ownership — which of ats-core / ai-platform / resume-ranker / message-service are ours | Notification module spec |
| ~~O-003~~ | ~~D-028a — conditional fields in v1~~ | Resolved: no |
| ~~O-004~~ | ~~D-028b — per-department template scoping~~ | Resolved: company-wide, column reserved |
| O-013 | Per-field audience on application forms (candidate / agency / internal) | Deferred, not v1 |
| O-014 | Interview scheduling contract with the calendar team (D-042) | Phase 5 |
| O-015 | BFF as separate deployable — trigger and timing (D-036) | Not blocking |
| O-016 | Cross-shard placement of engaged companies (D-041) | **Day 2 — accepted as deferred** |
| O-005 | Object storage provider for the hosted product | Deployment, not code (D-004 absorbs it) |
| O-006 | GDPR retention window per region — needs legal input | Automated retention only |
| O-007 | Pricing model, plan tiers | `plan_tier` placement; billing is Phase 2 |
| O-008 | Product name — FindNeo vs RecruitAI | Public-facing copy only |
| O-009 | Uptime SLA target | NFR verification, not code |
| O-010 | Guest panelist read access to the application they interview for | Interviews module |
| ~~O-011~~ | ~~Same email in platform-staff and tenant-user space~~ | **Resolved by D-049** |
| O-012 | Candidate declines all proposed interview slots | Interviews module; deferred deliberately |

---

## Superseded — do not reintroduce

These were live at some point and are now wrong. Listed because they appear in prior transcripts and extraction documents.

| Idea | Superseded by |
|---|---|
| `user_departments.role_id` as the role mechanism | D-007 |
| `organization_memberships` / `membership_roles` | D-007 |
| `user_roles.job_id` as job assignment | D-008 |
| `login_attempts` table — never existed; lockout is inline on `users` | — |
| Separate `platform_admins` table | D-005 |
| Subdomain-first login and tenant resolution | D-006 — email-first at one fixed domain; subdomain is career site only |
| A user belonging to multiple companies | D-007 — exactly one company per user |
| `org_candidate_pool` / `agency_candidate_pool` | D-010 |
| `applications.resume_url` | D-011 |
| Hard unique index for one active application | D-012 |
| Submission-time cool-off block | D-013 |
| Standalone `agencies` table | D-035 — agencies are companies via `company_type` bitwise flag |
| BullMQ / Redis | D-016 |
| Prisma | D-018 |
| `jobs.pipeline_template_id` — stale, unused | — |
| Job-keyed scorecard attributes | Stage-keyed: `UNIQUE(stage_id, attribute_id)` |
| `trg_focus_attribute_job_match` | `trg_focus_attribute_stage_match` |
