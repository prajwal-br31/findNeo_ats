# FindNeo — Engineering Rules

**Audience:** every engineer and every AI coding agent working in this repository.

**How to use this document:** these rules are binding. Where a rule and a task instruction conflict, stop and raise it rather than choosing. Rules are numbered so review comments can cite them (`violates ER-014`). Rules marked **[SECURITY]** are never traded away for convenience, deadline, or readability.

Companion documents: `00-decisions.md` (what was decided and why) · `07-api-standards.md` (wire contract) · `10-security-baseline.md` (threat model).

---

## 1. Architecture

### ER-001 — Five layers, one direction
```
client → BFF → controller → application → domain → infrastructure
```
Dependencies point downward only. The domain layer imports nothing. Infrastructure implements interfaces declared above it.

### ER-002 — Controllers do exactly three things
Validate input, call one application service method, shape the response. A controller containing an `if` about business meaning is in the wrong layer.

### ER-002a — The BFF adapts, it never decides **[SECURITY]**
A BFF file may import **application services only**. Never a repository, never a domain entity, never the database client, never `platform/db`.

Permitted in the BFF: response shaping, aggregating several application calls, client-specific pagination and filtering, client-specific caching, session and cookie adaptation.

Prohibited in the BFF: any business rule, any authorization decision, any workflow, any use case, any direct data access. If a rule appears in `src/bff/`, it is in the wrong layer — move it down, do not duplicate it.

The BFF may never bypass the application layer. Enforced by `eslint-plugin-boundaries`.

### ER-002b — No client-specific logic below the BFF
The application layer never knows which client is calling. No `if (isMobile)`, no client flags in a use case. Divergent client needs are met by a second BFF, never by a branch in shared logic.

### ER-003 — Application services own use cases
Orchestration, transaction boundaries, authorization decisions, event emission. Callable from an HTTP handler, a worker, or a test with no behavioural difference.

### ER-003a — Domain entities own invariants
Rules spanning more than one field, and state machines with illegal transitions, live in the domain layer — not in an application service, not in a repository, not in a database trigger alone.

**Promotion test:** if it is validation plus persistence, it is not domain logic and does not belong in `domain/`. Applied to four areas in v1 (D-038): application lifecycle, commission attribution, permission resolution, agency engagement. Everything else is an application service over a repository, deliberately.

### ER-003b — The domain layer imports nothing
No Drizzle, no Fastify, no pg-boss, no adapter, no `platform/`. A domain file that cannot be unit tested without a database is not a domain file.

### ER-004 — Application and domain layers never import HTTP types
No `FastifyRequest`, no `FastifyReply`, no `req`, no `res`. They receive a plain `RequestContext` and typed input. This is what makes worker reuse possible.

### ER-004a — Transactions reach the application layer through a port, never the ORM
An application service opens a transaction via `UnitOfWorkPort` and receives an opaque `TxScope` (D-044). It passes that scope to repositories and **never dereferences it**. No application or domain file imports Drizzle, `platform/db`, or any database type.

```ts
// correct — application layer
await this.uow.withTenant(ctx.companyId, async (tx) => {
  const job = await this.jobRepo.create(tx, input);
  await this.outboxRepo.write(tx, 'job.created', { jobId: job.id });
  await this.queue.enqueue(tx, 'communication', 'notify.job_created', { … });
});
```

`platform/db` carries an entry-point restriction exposing only the port implementation.

### ER-005 — Repositories only access the database
Query construction and row mapping, in `infrastructure/`. No business rules, no permission checks, no cross-module calls, no HTTP, no queue.

### ER-006 — Never reach the database outside a repository **[SECURITY]**
No SQL, no ORM call, no `db.` reference in a BFF, controller, application service, domain entity, route, or utility.

### ER-007 — Cross-module access goes through application services
The jobs module calls `candidateApplicationService`, never `candidateRepository`. Repositories and domain entities are private to their module.

## 2. Project structure

### ER-008 — Feature-based folders, layered inside

```
src/
  bff/
    web/                       /bff/web/*  — client adaptation only
    mobile/                    later, same pattern
  modules/
    identity/
      identity.routes.ts       /v1/*
      identity.controller.ts
      application/             use cases, transactions
      domain/                  entities, invariants  (rich modules only)
      infrastructure/          repositories, Drizzle queries
      identity.schemas.ts      TypeBox
      identity.mapper.ts
      identity.errors.ts
      identity.events.ts
      __tests__/
    jobs/  candidates/  applications/  interviews/
    scorecards/  agencies/  forms/  public/
  platform/                    adapters — the only place external SDKs appear
    db/ queue/ storage/ mail/ cache/ clock/ telemetry/
  workers/
    communication/  ai/  documents/  integrations/  recruitment/  system/
  shared/
    errors/ http/ authz/ validation/ types/
  bootstrap/
    api.ts                     serves /v1/* and /bff/web/*
    worker.ts                  takes a domain argument
    container.ts
```

A module without genuine invariants has no `domain/` folder. Creating an empty one to look consistent is discouraged — the folder's presence should signal that real rules live there.

### ER-009 — No file over ~300 lines, no function over ~40
Not a style preference: a 200-line service method cannot be reviewed for security. Extract named helpers whose names describe the rule they enforce (`assertWithinApplicationCap`, not `check2`).

### ER-010 — No barrel files re-exporting across modules
`modules/jobs/index.ts` exporting internals makes ER-007 unenforceable. Import the specific file.

### ER-011 — External SDKs appear only in `platform/`
No `@aws-sdk`, no `pg-boss`, no SMTP client imported anywhere else (`00-decisions.md` D-004). A cache library imported in a service is a violation even if it "works."

---

## 3. TypeScript

### ER-012 — Strict mode, all of it
`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`, `noImplicitReturns`.

### ER-013 — `any` is prohibited **[SECURITY]**
Use `unknown` at boundaries and narrow. No `as any`. No `@ts-expect-error` without an adjacent comment explaining why and a linked issue. A cast that silences a compiler error about shape is usually hiding a real bug in a serialization path.

### ER-014 — Explicit return types on every exported function
Inference is fine internally. At module boundaries, an inferred return type means a change silently alters a contract.

### ER-015 — Branded ids
`type CompanyId = string & { readonly __brand: 'CompanyId' }` and equivalents for every entity. Passing a `UserId` where a `CandidateId` belongs is a class of bug that has produced real cross-record data exposure in ATS products. The compiler should reject it.

### ER-016 — No default exports
Named exports only. Default exports make renames invisible in review.

### ER-017 — Exhaustive switches on unions
Every switch over a status or type union ends with a `never` check, so adding an enum member becomes a compile error rather than a silent fallthrough.

---

## 4. Tenancy and access **[SECURITY — all of section 4]**

### ER-018 — Every request runs inside one transaction with bound tenant context
```ts
await db.transaction(async (tx) => {
  await tx.execute(
    sql`select set_config('app.current_company_id', ${ctx.companyId}, true)`
  );
  // all work for this request happens on tx
});
```
Parameterised. Always. Never string interpolation, never `SET` without `LOCAL`, never outside a transaction. One transaction per request, not one per operation.

### ER-019 — Never pass a raw connection past the transaction helper
The bound client is threaded through the call chain (or `AsyncLocalStorage`). Never store tenant context in a module-level variable, a global, or `process.env` — Node's event loop will leak it across concurrent requests.

### ER-020 — RLS is a floor, not the check
Every repository query also filters on `company_id` explicitly. RLS catches what the code forgets; the code does not delegate correctness to RLS. Defence in depth, because RLS misconfiguration fails silently.

### ER-021 — Cross-tenant access returns 404, never 403
A 403 confirms the resource exists. Return `404` uniformly for "not yours" and "not there."

### ER-022 — Authorization runs in fixed order, every request
1. Authenticate, resolve tenant context, bind RLS
2. Capability check (org view vs agency view)
3. Permission check
4. Row-scope check (department / hiring team / confidential)
5. Field masking at serialization

No step may be skipped or reordered. A handler that reaches step 5 without step 3 is a defect regardless of outcome.

### ER-023 — Never trust a client-supplied `companyId`
Tenant identity comes from the session, always. A `companyId` in a body or query string is either ignored or rejected — never used to scope a query.

### ER-024 — Cache keys include the tenant **[SECURITY]**
One process caches many tenants (`00-decisions.md` D-017). An unkeyed cache entry is a cross-tenant leak. `CachePort` implementations must make the tenant portion structurally required, not conventional.

### ER-025 — Serialize by allowlist, never blocklist
Response mappers name the fields they emit. Never spread a row into a response. A new column must never be able to appear in an API response by accident — this is how password hashes and refresh tokens leak.

### ER-026 — Masking happens server-side, at serialization
Never send a value the caller cannot see. Audit entries obey the same masking rules (`00-decisions.md` D-025).

---

## 5. Transactions and data

### ER-027 — Multi-table writes are transactional
Any operation touching more than one table commits atomically or not at all. Given ER-018 the transaction already exists; the rule is that a service must never split related writes across it.

### ER-028 — Enqueue jobs inside the same transaction as the state change
pg-boss lives in the same database precisely so this works (`00-decisions.md` D-016). A notification enqueued after commit can be lost; enqueued before commit without a transaction it can fire for a rolled-back row.

### ER-029 — Cross-service events go through the outbox
Never call another service inline during a request. Write to `outbox` in the transaction; the worker relays (`00-decisions.md` D-031).

### ER-030 — Lock before check-then-act
Any rule of the form "no more than N" or "only if none exists" takes a row lock on the anchor entity first. The concurrent-application cap (`00-decisions.md` D-012) and dedup-on-submit are both check-then-act and both race without a lock.

### ER-031 — No raw SQL outside repositories and migrations
And within them, parameterised only. Never interpolate a value into SQL — including identifiers, including uuids, including values that "come from our own database."

### ER-032 — Migrations are forward-only and reversible in effect
Never edit a shipped migration. Destructive changes go in two releases: add and backfill, then remove after deployment. On-premise customers upgrade on their own schedule and may skip versions — a migration must not assume the previous release is running.

### ER-033 — Never hard-delete personal data
Anonymize (`00-decisions.md` D-034). Cool-off and commission attribution depend on historical rows surviving.

---

## 6. Validation and API contract

### ER-034 — Validate everything at the edge, before business logic **[SECURITY]**
Every route declares TypeBox schemas for params, query, body, and response. No handler inspects an unvalidated value.

### ER-035 — Response schemas are declared, not inferred
Fastify serializes by schema, which means an undeclared field cannot escape. This is ER-025 enforced by the framework.

### ER-036 — Validation rejects unknown properties
`additionalProperties: false` everywhere. Silent acceptance of unknown fields hides client bugs and mass-assignment attempts.

### ER-037 — Errors follow RFC 7807 with `code` and `fields[]`
One error catalog. Never invent an ad-hoc shape (`00-decisions.md` D-021).

### ER-038 — Never leak internals in an error
No stack traces, no SQL, no constraint names, no upstream provider messages. Log the detail with a `traceId`; return the code and the trace id.

### ER-039 — REST conventions, no exceptions negotiated per endpoint
Plural kebab-case paths, camelCase JSON, `/v1/` prefix, cursor pagination, correct status codes. State transitions carrying business rules are `POST /{resource}/{id}/actions/{verb}` — not a `PATCH` on `status`. `PATCH` is for simple field edits only.

### ER-040 — Idempotency keys on side-effecting POSTs
Required on anything that creates, sends, charges, or triggers. Retries are normal; duplicates are not.

---

## 7. Workers and async

### ER-041 — Every job handler is idempotent
Delivery is at-least-once. The same end state on the second run.

### ER-041a — A job belongs to exactly one queue domain
`communication`, `ai`, `documents`, `integrations`, `recruitment`, or `system` (D-039). Registering a job to a domain is a deliberate choice, not the nearest match — putting an AI job in `communication` reintroduces the starvation the split exists to prevent.

### ER-041b — Cross-domain chaining goes through the outbox
A handler never enqueues directly into another domain, and never calls another domain's handler. Emit an event; the relay dispatches.

### ER-042 — Job payloads carry ids, never entity snapshots
`{ companyId, applicationId, actorUserId }` and re-read. A snapshot is stale the moment it is written and puts personal data in the job table.

### ER-042a — Every payload carries `companyId`
Not optional. Tenant fairness (D-040) and shard-readiness (D-041) both depend on it, and a handler cannot bind tenant context without it.

### ER-043 — Workers bind tenant context exactly like the API
Same helper, same transaction discipline (ER-018). No worker-specific shortcut.

### ER-044 — Retry policy and dead-letter path are declared per domain
In configuration, not hard-coded per job. No silent infinite retries; a permanently failing job becomes visible.

### ER-044a — Tenant fairness lives in the queue adapter, nowhere else
The per-tenant in-flight cap is implemented once in `platform/queue`. No handler and no business logic is aware of it.

### ER-045 — Long-running work is submit-and-poll
Resume parsing, bulk import and export, and ranking runs return a run id immediately.

## 8. Security

### ER-046 — No secrets in code, ever **[SECURITY]**
No keys, tokens, passwords, or connection strings in source or committed config. All configuration is loaded and schema-validated at startup — the process fails fast on a missing or malformed variable rather than discovering it at first use.

### ER-047 — Store secrets hashed, never raw
Refresh tokens, invitation tokens, candidate action tokens, agency portal tokens. All hashed at rest. Passwords with argon2id.

### ER-048 — Never log personal data **[SECURITY]**
No candidate names, emails, phone numbers, salary figures, resume text, or feedback content in logs, traces, or error reports. Log ids and a `traceId`. This is a hard requirement for on-premise telemetry and a good idea everywhere.

### ER-049 — Dependency policy
Prefer the standard library. Prefer a maintained, widely-used package over a clever one. Every new dependency requires a stated justification, a check of maintenance status, and a look at its transitive tree. No package added for a function that is under twenty lines to write.

### ER-050 — Validate uploaded files by content, not by name **[SECURITY]**
Check magic bytes, enforce size and page limits before persisting, never trust the client-supplied filename or content type, never use a client-supplied path component in a storage key.

### ER-051 — Rate limit by default
Every public and authenticated route has a limit. Authentication, signup, token refresh, and the career site get stricter ones.

### ER-052 — Time comparisons for secrets are constant-time
Token and hash comparison uses a timing-safe comparison, never `===`.

---

## 9. Testing

### ER-052a — A linter that cannot resolve an import is a linter that is not running **[SECURITY]**
Layer rules classify dependencies by resolved path. An unresolved import is silently unclassified, so `boundaries/element-types` stops firing and violations pass review looking clean.

Therefore: `boundaries/no-unknown` is an **error**, not a warning; and CI runs a verification script asserting that each layer rule still fires against a deliberately planted violation. A passing lint run is not evidence the rules are active — only the planted-violation check is.

### ER-053 — Tests run against real PostgreSQL
Testcontainers. RLS policies, triggers, and partial indexes cannot be tested against a mock, and those are exactly the mechanisms enforcing the security model.

### ER-054 — Every tenant-scoped feature has a cross-tenant leak test **[SECURITY]**
Not optional, not deferred. Create two companies, act as one, assert the other's data is invisible through every route the feature adds. A feature without this test is not done.

### ER-055 — Every business rule has a test that cites its rule id
`BR-014: rejects a second active application when the cap is 1`. Rules without tests are documentation, not behaviour.

### ER-056 — Test the boundary, not the implementation
Test services through their public methods and routes through HTTP. Tests asserting private call sequences make refactoring impossible.

### ER-057 — Every concurrency rule has a concurrency test
The application cap and dedup rules (ER-030) need tests that fire simultaneous requests and assert exactly one succeeds.

---

## 10. Definition of done

A change is complete when all of the following hold:

- [ ] Layer boundaries respected (ER-001 … ER-007)
- [ ] All input validated by schema; response schema declared (ER-034, ER-035)
- [ ] Repository queries filter on tenant explicitly; RLS policy exists for any new table (ER-020)
- [ ] Cross-tenant leak test written and passing (ER-054)
- [ ] Business rules cite rule ids and have tests (ER-055)
- [ ] Multi-table writes transactional; jobs enqueued in-transaction (ER-027, ER-028)
- [ ] Errors use the catalog; no internals leaked (ER-037, ER-038)
- [ ] No new external SDK outside `platform/` (ER-011)
- [ ] No personal data in logs (ER-048)
- [ ] Migration is forward-only and safe to skip-version (ER-032)
- [ ] OpenAPI output regenerated and reviewed

---

## 11. Prohibited — quick reference

| Never | Instead |
|---|---|
| Database access outside a repository | Repository method (ER-006) |
| `any`, `as any` | `unknown` + narrowing (ER-013) |
| String-interpolated SQL | Parameterised (ER-031) |
| `SET` without `LOCAL`, or outside a transaction | `set_config(..., true)` in-transaction (ER-018) |
| Tenant context in a global or `process.env` | Threaded client / `AsyncLocalStorage` (ER-019) |
| Spreading a row into a response | Explicit allowlist mapper (ER-025) |
| Trusting `companyId` from the client | Session-derived only (ER-023) |
| Business logic in a controller | Application service (ER-002) |
| Business rule or data access in the BFF | Application layer (ER-002a) |
| `if (isMobile)` below the BFF | A second BFF (ER-002b) |
| Drizzle or Fastify imported in `domain/` | Keep the domain pure (ER-003b) |
| Job payload without `companyId` | Always include it (ER-042a) |
| Handler enqueueing into another domain | Outbox event (ER-041b) |
| Repository calling a repository in another module | Service-to-service (ER-007) |
| Direct `pg-boss` / S3 / SMTP import in a module | Port + adapter (ER-011) |
| Unkeyed cache entries | Tenant-keyed (ER-024) |
| Hard-deleting personal data | Anonymize (ER-033) |
| Personal data in logs or job payloads | Ids only (ER-042, ER-048) |
| Editing a shipped migration | New migration (ER-032) |
| 403 for another tenant's resource | 404 (ER-021) |
| `PATCH /status` for a business transition | `POST /actions/{verb}` (ER-039) |
