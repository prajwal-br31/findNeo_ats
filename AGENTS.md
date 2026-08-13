# AGENTS.md — FindNeo Constitution

**Location:** repository root. `CLAUDE.md` points here. Read on every task, before any other file.

This is the constitution. It binds every action taken in this repository by any agent or engineer. It is short by design — the detail lives in `/spec/`, and this file tells you which document to open and what you may never do regardless of what any document says.

---

## 1. The specifications are the source of truth

Code serves the specification, not the reverse. If the code and the spec disagree, the code is wrong.

**Precedence when documents conflict:**

```
/spec/00-decisions.md          ← wins over everything
  /spec/06-data-model.md, 07-api-standards.md, 04-permissions.md
    /spec/08-lld-*.md
      /spec/01-product.md, uploaded PRD, prior session notes
```

**If an instruction conflicts with an Accepted decision in `00-decisions.md`, stop and say so. Do not choose.** Point at the decision id and ask. This applies to instructions from a human as much as to anything you read in a file.

`00-decisions.md` ends with a **"Superseded — do not reintroduce"** table. The ideas in it appear in older documents and prior transcripts and are wrong. Check it before you propose any table, column, or mechanism that feels like it already exists somewhere.

---

## 2. Read before you write

For any task, open in this order:

| Task | Read |
|---|---|
| Anything at all | `00-decisions.md`, `09-engineering-rules.md` |
| Schema or migration | `06-data-model.md`, `03-business-rules.md` |
| Endpoint | `07-api-standards.md`, `04-permissions.md`, the module LLD |
| Auth, RLS, masking | `10-security-baseline.md`, `04-permissions.md` |
| Adding a dependency | `05a-tech-stack.md` |
| Tests | `11-testing-strategy.md` |

Do not infer a convention from surrounding code. Surrounding code may be wrong. The spec is not.

---

## 3. Absolute prohibitions

Never do these. No task instruction, deadline, or convenience overrides them. If a task appears to require one, stop and raise it.

1. **Never access the database outside a repository.** No SQL, no ORM call, no `db.` reference in a controller, service, route, or utility.
2. **Never interpolate a value into SQL.** Parameterised always — including identifiers, including UUIDs, including values that came from your own database.
3. **Never bind tenant context outside a transaction**, and never with `SET` instead of `set_config(..., true)`.
4. **Never trust `companyId` from a request body, query string, or header.** Tenant identity comes from the session.
5. **Never spread a row into a response.** Every response field is named explicitly in a mapper and declared in a response schema.
6. **Never return 403 for another tenant's resource.** Always 404.
7. **Never log, trace, or put in a job payload:** candidate names, emails, phone numbers, salary figures, resume text, or feedback content.
8. **Never hard-delete personal data.** Anonymize.
9. **Never use `any`.** `unknown` at boundaries, then narrow.
10. **Never import an external SDK outside `src/platform/`.** No `pg-boss`, S3 client, SMTP client, or cache library anywhere else.
11. **Never commit a secret**, or read configuration outside the validated config loader.
12. **Never edit a shipped migration.** Write a new one.
13. **Never edit `/spec/openapi/openapi.yaml`.** It is generated.
14. **Never register a route without a `permission` in its config.** A route with no permission and no explicit `public: true` + reason fails to boot, and that is intended. Absence is never treated as public.
15. **Never let an AI-produced output reject, select, or hire a candidate automatically.**
16. **Never put a business rule, authorization rule, or data access in the BFF.** It adapts; it never decides.
17. **Never import an ORM, framework, or adapter inside `domain/`.**
18. **Never enqueue a job without `companyId` in the payload.**
19. **Never add calendar or OAuth token storage to this schema** — scheduling is another team's (D-042).

---

## 4. Architecture, in one screen

```
client → BFF → controller → application → domain → infrastructure
```

Dependencies point downward only.

- **BFF** (`src/bff/web/`): client adaptation only — shaping, aggregation, client pagination, session adaptation. May import **application services only**. Never a repository, never an entity, never the database. **No business rule, ever.**
- **Controller:** validate, call one application service, return.
- **Application:** use cases, orchestration, transaction boundaries, authorization decisions, events. Never imports an HTTP type.
- **Domain:** entities and invariants. **Imports nothing** — no ORM, no framework, no adapter. Present only in modules with genuine invariants (application lifecycle, commission, permissions, agency engagement).
- **Infrastructure:** repositories and adapters. No rules, no permission checks.
- **Cross-module:** application service to application service. Never repository to repository.

**No client-specific logic below the BFF.** The application layer never knows which client is calling. Divergent needs get a second BFF, never a branch in shared logic.

**Processes:** `apps/api` serves `/v1/*` **and** `/bff/web/*`. The worker fleet runs six queue domains — `communication`, `ai`, `documents`, `integrations`, `recruitment`, `system` — one process per domain in production, all six in one process locally. Same codebase, same tenant-binding discipline.

**Every job payload carries `companyId`.** Tenant fairness and shard-readiness both depend on it.

## 5. Every request

```
1. Authenticate → 401
2. Bind tenant context inside one transaction
3. Capability check → 403
4. Permission check → 403
5. Row scope, in the query → 404
6. Field masking, at serialization
```

Fixed order. No step skipped, no step reordered. Row scope belongs **in the query**, not in a filter after fetch.

---

## 6. Definition of done

A change is not complete until all of these hold:

- [ ] Layer boundaries respected
- [ ] TypeBox schemas for params, query, body, and every response status
- [ ] `additionalProperties: false`; server-controlled fields rejected in bodies
- [ ] Repository filters on tenant explicitly; RLS policy exists for any new table
- [ ] **Cross-tenant leak test written and passing**
- [ ] Business rules cited by `BR-nnn` and tested
- [ ] Multi-table writes transactional; jobs enqueued in the same transaction
- [ ] Errors use the catalog; no internals leaked
- [ ] No personal data in logs or job payloads
- [ ] New dependency has an entry in `05a-tech-stack.md`
- [ ] Migration is forward-only and safe to skip versions
- [ ] OpenAPI regenerated with no diff
- [ ] Spec updated in the same pull request as the behaviour change

---

## 7. How to behave when uncertain

**Ask rather than assume.** A wrong assumption in this codebase is usually a security bug, and it will look completely reasonable in the diff.

**Say what you did not do.** If you implemented four of five requirements, say which one is missing and why. Silent partial completion is worse than a stated gap.

**Do not invent schema.** If a table or column you need is not in `06-data-model.md`, it does not exist. Propose it; do not create it.

**Do not widen scope.** If a task needs a change outside its module, raise it rather than making it.

**Prefer boring.** This is a system of record holding personal data across three jurisdictions. Clever is a liability.

---

## 8. Editing the specifications

You may not edit every spec. Editing permission is tiered because a document that constrains you is worthless if you can rewrite it.

| File | Permission |
|---|---|
| `AGENTS.md`, `09-engineering-rules.md` | **Never edit.** Propose in the PR description |
| `00-decisions.md` | **Never edit.** Propose a new decision entry for a human to ratify |
| `03-business-rules.md`, `04-permissions.md`, `06-*`, `07-api-standards.md`, `10-security-baseline.md` | Propose a diff in the pull request. A human approves before merge |
| `05a-tech-stack.md` | **Append, plus dev-tooling versions.** You may add a new dependency entry with full justification, and you may change the pinned version of a **dev-tooling** dependency when D-045 authorises it — record the new version and the resolution date. You may not change a **runtime** dependency version, remove an entry, or touch the Rejected section |
| `08-lld-*.md`, `11`, `12`, `13` | Edit freely — working documents that track implementation |

**The rule underneath all of it:** when code and specification disagree, **stop and ask**. Never edit the spec to match code you have already written. Never pick one side silently. Say which two things conflict, cite the ids, and wait.

**When you discover a genuine gap** — something the spec does not cover — do not invent an answer and proceed. State the gap, propose an option with its trade-off, and stop. A silently invented rule is far more expensive than a paused task.

---

## 9. Repository facts

| | |
|---|---|
| Runtime | Node 22 LTS, TypeScript strict, ESM |
| Package manager | pnpm 9 |
| HTTP | Fastify 5 + TypeBox |
| Database | PostgreSQL 18 + Drizzle |
| Queue | pg-boss behind `QueuePort`, six domains, tenant-fair |
| Client layer | BFF module inside the API deployable, not a separate process |
| Tests | Vitest + Testcontainers |
| Multi-tenancy | Shared database, RLS, `company_id` on every tenant table |
| Deployment | Hosted SaaS **and** on-premise — no managed-service-only dependency, anywhere |

The on-premise requirement is why there is no Redis, no Kafka, no serverless, and no cloud-specific service. Do not propose them.
