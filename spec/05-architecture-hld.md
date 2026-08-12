# FindNeo — Architecture (HLD)

How the system is composed, how the pieces communicate, and how it deploys to two very different targets.

---

## 1. Shape

```
   Web client                       Integrations · Career site embed
        │                                        │
        ▼                                        ▼
  ┌───────────┐                            ┌───────────┐
  │  BFF      │  client adaptation only    │  /v1/*    │  canonical API
  │ /bff/web  │                            │           │
  └─────┬─────┘                            └─────┬─────┘
        └──────────────┬───────────────────────-─┘
                       ▼
              ┌──────────────────┐
              │  Application     │  use cases, orchestration, transactions
              └────────┬─────────┘
                       ▼
              ┌──────────────────┐
              │  Domain          │  entities, invariants  (depends on nothing)
              └────────┬─────────┘
                       ▼
              ┌──────────────────┐
              │  Infrastructure  │  Drizzle · pg-boss · storage · mail · AI
              └────────┬─────────┘
                       ▼
                 PostgreSQL 18
                       ▲
              Worker fleet (6 domains)
```

**Dependencies point downward only.** The domain layer imports nothing — no ORM, no framework, no adapter. Infrastructure implements interfaces the layers above declare.

**Why not microservices.** Every candidate operation touches jobs, applications, candidates, and audit. Splitting those replaces one transaction with a distributed-consistency problem. Strong internal boundaries first; extract a service when a concrete driver appears (D-036, D-039).

**Why the BFF is a module, not a process** (D-036). A module boundary delivers what the BFF exists for — isolated client concerns, business logic below it, a Mobile BFF addable later — at zero on-premise cost, with one auth surface and no added hop. The boundary is enforced by `eslint-plugin-boundaries`, so extraction later is moving a folder. Extract when deploy cadence or client-team independence demands it, not before.

**Why `/v1/*` survives alongside the BFF.** Three consumers need it: integrations, the career site embed, and on-premise customers with their own tooling. It is a first-class surface, never "the thing behind the BFF."

---

## 2. Layers

```
src/
  bff/
    web/                    /bff/web/*  — aggregation, shaping, session adaptation
    mobile/                 later, same pattern
  modules/<module>/
    <module>.routes.ts      /v1/*
    <module>.controller.ts
    application/            use cases, orchestration, transaction boundaries
    domain/                 entities and invariants  (rich modules only)
    infrastructure/         repositories, Drizzle queries
  platform/                 adapters: db, queue, storage, mail, cache, clock
  workers/
    communication/  ai/  documents/  integrations/  recruitment/  system/
  shared/                   errors, http envelopes, authz, validation
```

### What each layer may do

| Layer | May | May never |
|---|---|---|
| BFF | Call application services. Shape, aggregate, paginate for a client | Touch a repository, entity, or the database. Hold any business or authorization rule |
| Controller | Validate, call one application service, return | Business logic |
| Application | Orchestrate, own transactions, decide authorization, emit events | Contain invariants that belong to an entity. Know which client is calling |
| Domain | Enforce invariants, model state machines | Import an ORM, a framework, or an adapter |
| Infrastructure | Query, map rows, implement ports | Contain rules or permission checks |

**Enforced by linter, not review.** `eslint-plugin-boundaries` rejects a BFF file importing a repository, and a domain file importing Drizzle.

### The pragmatic domain layer (D-038)

Rich domain modelling in four places, because they carry invariants that span fields and states:

| Domain area | Why it earns modelling |
|---|---|
| Application lifecycle | A state machine with illegal transitions and a concurrency-sensitive cap |
| Commission attribution | Cool-off lookback, snapshotting, two-party ownership |
| Permission resolution | Union semantics, scope layering, escalation guard |
| Agency engagement | Access is derived, not stored — the easiest thing in the system to get wrong |

Everything else — departments, skills, form templates, hiring team — is an application service over a repository. Modelling `PATCH /v1/departments/{id}` as an aggregate is overhead, and uniform overhead is how a team quietly abandons an architecture.

**Promotion test:** does it have an invariant spanning more than one field, or a state machine with illegal transitions? If not, it is validation plus persistence, and it stays out of the domain layer.

---

## 3. Ports and adapters

Everything external is a port (D-004). Forced by on-premise, useful everywhere.

| Port | Hosted | On-premise |
|---|---|---|
| `StoragePort` | S3 | MinIO (S3 API) or filesystem |
| `MailPort` | Provider API | SMTP |
| `QueuePort` | pg-boss | pg-boss |
| `CachePort` | In-process LRU | In-process LRU |
| `ClockPort` | System | System |
| `TelemetryPort` | OTLP collector | Customer collector, or disabled |

`ClockPort` is deliberate: cool-off windows, token expiry, and retention clocks are time-dependent rules and must be testable without sleeping.

`QueuePort` carries more weight than the others — it owns tenant fairness (D-040) and is the seam that lets a heavy workload move to different infrastructure later (D-041). Business logic never imports pg-boss.

---

## 4. Request lifecycle

```
1  Fastify receives, assigns traceId
2  Rate limit
3  Authenticate — verify JWT, load session
4  Resolve capability (organization | agency)
5  BEGIN TRANSACTION
6  set_config('app.current_company_id', $1, true)
7  Permission check from route metadata
8  Controller validates (TypeBox)
9  Service executes business logic
10 Repository queries — RLS + explicit filter + row scope
11 Outbox rows and job enqueues written in the same transaction
12 COMMIT
13 Mapper builds response (allowlist)
14 Masking applied
15 Fastify serializes against the response schema
```

Steps 5–12 are one transaction. Step 15 is the final structural guarantee that an undeclared field cannot escape.

---

## 5. Async processing — the worker fleet

pg-boss is the asynchronous **workflow layer**, not merely a transactional side-effect mechanism (D-039).

### Six queue domains, six pools

| Domain | Workloads | Character |
|---|---|---|
| `communication` | Email, SMS, push, interview reminders | Latency-sensitive, must never starve |
| `ai` | Parsing, embeddings, ranking, transcription | Slow, bursty, expensive |
| `documents` | Resume copy, exports, generation | Moderate, I/O bound |
| `integrations` | Webhooks, calendar sync, external systems | Unreliable upstreams, aggressive retry |
| `recruitment` | Pipeline automation, SLA tracking, aging | Scheduled, low urgency |
| `system` | Cleanup, retention, reports, maintenance | Off-peak |

Each is a separate queue with its own pool, independently scalable. **This split is the only reason an interview reminder stays fast while a bulk embedding run is in flight** — a single pool means AI work starves everything else.

Per-domain policy — concurrency, priority, retry and backoff, rate limit, timeout — is declared in configuration:

```ts
export const queuePolicies = {
  communication: { concurrency: 20, priority: 'high',   retries: 5, backoff: 'exponential', tenantCap: 5 },
  ai:            { concurrency: 4,  priority: 'low',    retries: 2, backoff: 'exponential', tenantCap: 1, timeoutMs: 300_000 },
  documents:     { concurrency: 8,  priority: 'normal', retries: 3, tenantCap: 3 },
  integrations:  { concurrency: 10, priority: 'normal', retries: 6, backoff: 'exponential', tenantCap: 3 },
  recruitment:   { concurrency: 4,  priority: 'low',    retries: 3, tenantCap: 2 },
  system:        { concurrency: 2,  priority: 'lowest', retries: 2, tenantCap: 1 },
} as const;
```

One process per domain in production; all domains in one process for local development. A job registers to exactly one domain. Cross-domain chaining goes through the outbox, never a direct call.

### Tenant fairness (D-040)

**No per-tenant queues** — that is an unbounded number of queues. Every payload carries `companyId`, and `QueuePort`'s fetch path caps in-flight jobs per tenant within each domain: a tenant at its cap is skipped and the next tenant's work is taken.

This requires a **custom claim query** — it is not pg-boss default behaviour. It lives entirely in the adapter; no handler and no business logic knows it exists.

Without it, one tenant's bulk import occupies every slot and every other tenant's notifications stop. That is a full outage caused by one tenant's ordinary action, and it is the most likely multi-tenant availability incident in this product.

### Transactional enqueue

```ts
await db.transaction(async (tx) => {
  await bindTenant(tx, ctx.companyId);
  const decision = await stageDecisionRepo.create(tx, input);
  await outboxRepo.write(tx, 'application.stage_changed', { … });
  await queue.enqueue(tx, 'communication', 'notify.stage_changed',
                      { companyId, applicationId });
});
```

All four writes commit together or none does. This is the entire reason pg-boss was chosen over a Redis-backed queue.

**Every handler:** binds tenant context from the payload using the same helper the API uses, is idempotent, declares a retry policy, and dead-letters rather than retrying forever. Payloads carry ids only, never personal data.

---

## 6. Multi-tenancy and scale posture

Shared database, RLS, `company_id` on every tenant table (D-001). Three database roles at least privilege.

**Agencies are companies.** One `companies` table with a bitwise capability flag; a dual-capacity business is one row. The agency portal reads through `agency_engagements` and never rebinds tenant context (D-014).

### Shard-ready, not sharded (D-041)

The design must not preclude horizontal partitioning at very large tenant counts. It does not build sharding now — premature sharding costs enormously and buys nothing at current volume.

**In place now, because retrofitting is expensive:**
- `company_id` leads every tenant index and is the de facto partition key
- No query joins across tenants; no aggregate spans tenants
- Every job payload carries `companyId`
- Queue behind `QueuePort`; database behind repositories — a routing layer inserts in one place
- No global sequences. `uuidv7()` throughout

**Not now:** shard routing, tenant-location registry, cross-shard planning, Redis, Kafka.

**The one place this does not shard cleanly.** `agency_engagements` and `commission_attributions` reference **two** companies. Under `company_id` sharding a client and its agency may land on different shards, and neither table has a natural home. Two viable answers when it becomes real: co-locate engaged companies on one shard, or keep a small globally-replicated relationship store. Recorded as O-016; not a reason to change anything today.

**Dedicated-database tier** for a large customer remains available without redesign — the same software against its own database, routed at connection time.

---

## 7. Deployment

### Hosted

```
CDN → Load balancer → API (n)  ─┐   (serves /v1/* and /bff/web/*)
                                 ├─ PgBouncer (transaction mode) → PostgreSQL 18 (+ replica)
  Worker: communication (n) ─────┤
  Worker: ai (n)            ─────┤
  Worker: documents         ─────┤
  Worker: integrations      ─────┤
  Worker: recruitment       ─────┤
  Worker: system            ─────┘
```

One worker deployment per domain, each scaled to its own load. AI scales independently of communication — that is the point of D-039.

Transaction-mode pooling is safe because tenant context uses `set_config(..., true)`, which is transaction-local.

### On-premise

```
docker compose up
  ├─ findneo-api          (serves /v1/* and /bff/web/*)
  ├─ findneo-worker       (all six domains in one process)
  ├─ postgres:18
  └─ minio (optional)
```

Same images, different configuration. The worker takes a domain list; on-premise it runs all six in one process because a single-tenant install has no starvation problem to solve. **This is configuration, not a code path** — no `if (onPremise)` anywhere.

**The on-premise target dictates:** no Redis, no Kafka, no serverless, no cloud-only service, telemetry off by default, per-install secrets, skip-safe migrations, and the BFF as a module rather than a fourth container (D-036).

---

## 8. Service boundaries and external seams

**Owned here:** ATS core — API (including the BFF module) and the worker fleet.

**Owned by other teams:**

| Area | Team | Contract |
|---|---|---|
| Resume ranking, candidate matching | AI team | **Open — O-001** |
| Calendar integration, interview scheduling | Scheduling team | **Open — O-014** (D-042) |
| Notification delivery service | Undetermined | **Open — O-002** |

### Calendar and scheduling (D-042)

The ATS owns *who is on the panel and what they concluded*: `interviews`, `interview_panelists`, `interview_slots`, `candidate_action_tokens`, panelist authority, scorecards, stage decisions.

The scheduling team owns *when it happens and how the calendar knows*: provider OAuth, connection storage, availability computation, event creation and sync.

**No `calendar_connections` table and no OAuth token storage in this schema.** If that appears here, the boundary has been crossed.

### AI seam

```
ats-core ──▶ outbox ──▶ ai worker ──▶ POST /rank { runId, jobId, applications[] }
                                            │
ats-core ◀── POST /v1/internal/ranking-results  ◀── (or poll)
```

Required regardless of poll or callback:
- `runId` issued by ats-core, echoed on every result
- Idempotent on `runId` — redelivery must not double-write
- Model identity and version recorded on every produced row (BR-112)
- Ids and structured fields only; no raw personal data beyond what ranking requires
- A terminal `failed` state with a reason — never an indefinite `queued`
- **AI never decides.** Output is a suggestion a human reviews (BR-110)

---

## 9. Non-functional targets

| Concern | Target |
|---|---|
| Authorization overhead | Sub-5ms per request, via indexed lookups and in-process caching |
| List endpoints | p95 under 200ms at 100k applications per tenant |
| Availability | **Open (O-009)** — needs a stated SLA before launch planning |
| Backup | Nightly full, PITR via WAL. Restore tested quarterly, not assumed |
| Audit growth | Monthly partitions from day one |
| Horizontal scaling | API stateless; worker concurrency-bounded |

**Known limits, accepted:** in-process cache means minutes of staleness across instances for rarely-changing lookups (D-017); rate limits are per-instance in v1; no realtime transport (D-024).

---

## 10. Where each concern is enforced

| Concern | Enforced |
|---|---|
| Tenant isolation | Database (RLS) + repository + session |
| Cross-tenant association | Database (composite FK) — RLS cannot see this |
| Permissions | Service, from route metadata |
| Row scope | Repository, in the query |
| Field masking | Serialization |
| Business invariants | Database where corruption is possible, service otherwise |
| Request shape | API edge (TypeBox) |
| Layer boundaries | Linter |
| Injection, spread, tenant leaks | Semgrep |

A rule enforced only in prose is not enforced.
