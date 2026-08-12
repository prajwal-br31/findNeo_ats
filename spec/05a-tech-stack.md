# FindNeo — Technology Stack & Dependencies

Every technology and library the backend uses, at a pinned version, with the reason it was chosen and what it was chosen over. Nothing enters the dependency tree without an entry here.

**Hard constraints shaping every choice below:**

1. **On-premise (D-002)** — a customer must be able to run this with Postgres and Node and nothing else. No managed-service-only dependency, anywhere.
2. **RLS transaction binding (D-001)** — the data layer must expose a transaction-scoped client that guarantees every statement runs on the connection where `set_config` was called.
3. **Longevity** — this is a system of record holding personal data for years. An unmaintained dependency is a security liability, not an inconvenience.

---

## 1. Runtime and language

| Component | Version | Notes |
|---|---|---|
| Node.js | 22 LTS | Pinned in `.nvmrc` and the Dockerfile. Maintenance through 2027 |
| TypeScript | 5.x | Strict flags per ER-012 |
| Package manager | pnpm 9 | Strict node_modules layout prevents phantom dependencies — a package can only import what it declares |
| Module system | ESM | `"type": "module"` |
| Build | tsc + tsx (dev) | No bundler for a server. A bundler adds a failure mode and buys nothing here |

**Node 22 over 24:** LTS maturity matters more than new features for a system of record. Revisit when 24 reaches LTS maturity.

---

## 2. Data layer

| Component | Version | Purpose |
|---|---|---|
| PostgreSQL | 18 | Primary datastore. `uuidv7()` native (D-032) |
| `pg` | 8.x | Driver. The reference Postgres client for Node |
| `drizzle-orm` | 0.3x | Query builder and typed schema |
| `drizzle-kit` | 0.3x | Migration generation |

### Why Drizzle, and what it was chosen over

**Prisma — rejected (D-018).** Its client abstracts connection acquisition, which fights transaction-bound session state. The widely circulated RLS workaround wraps every operation in its own transaction, destroying multi-statement transactions and throughput. The version of that workaround in this project's own RBAC appendix additionally interpolated the tenant id into raw SQL — an injection vector. Recorded so it is not reintroduced.

**TypeORM — rejected.** Decorator-based, heavy runtime metadata, a history of surprising migration behaviour.

**Knex + hand-rolled types — viable, rejected.** Works, but types are maintained by hand and drift from the schema.

**Drizzle — chosen.** Schema is TypeScript, so types derive from the schema rather than being maintained alongside it. `db.transaction()` yields a client bound to one connection, which is exactly what ER-018 requires. Generated SQL is readable, which matters when reviewing an RLS-sensitive query.

**Migration policy.** Drizzle Kit generates; a human reviews and commits the SQL. Migrations are applied by an explicit command in a release step, never automatically on process boot — an on-premise customer must be able to run migrations as a deliberate, reversible operation with a backup taken first (ER-032).

**Connection pooling.** `pg.Pool` in-process, PgBouncer in **transaction mode** in front for the hosted product. Transaction mode is safe because tenant context uses `set_config(..., true)`, which is transaction-local and released at commit. Session mode is not required — the contrary advice in the uploaded RBAC appendix is over-cautious and costs a large amount of pooling efficiency.

---

## 3. HTTP layer

| Component | Version | Purpose |
|---|---|---|
| `fastify` | 5.x | HTTP server |
| `@sinclair/typebox` | 0.3x | Schema definition |
| `@fastify/type-provider-typebox` | 5.x | Schema → TypeScript inference |
| `ajv` | 8.x | Validation engine (via Fastify) |
| `@fastify/swagger` | 9.x | OpenAPI generation from route schemas |
| `@fastify/swagger-ui` | 5.x | Swagger UI — **non-production only** |
| `@fastify/helmet` | 12.x | Security headers |
| `@fastify/cors` | 10.x | CORS |
| `@fastify/cookie` | 11.x | Signed cookies for the refresh token (D-020) |
| `@fastify/rate-limit` | 10.x | Rate limiting (ER-051) |
| `@fastify/multipart` | 9.x | Resume upload (D-022) |
| `@fastify/under-pressure` | 9.x | Load shedding and health checks |

### Why Fastify over Express and NestJS

**Express — rejected.** Validation, serialization, and typing are all bolt-ons. No schema-driven response serialization, which is the mechanism enforcing ER-025's allowlist. Doing it manually everywhere is a leak waiting to happen.

**NestJS — rejected.** Genuinely good, and the DI container is real value. But it brings a large opinionated framework, decorator metadata, and a learning surface, and its class-validator path duplicates schema definitions rather than deriving them. For a small team the framework becomes a second thing to debug.

**Fastify — chosen.** Schema-driven validation *and* serialization. The response schema is the allowlist — an undeclared field physically cannot be serialized, which converts ER-025 from a review rule into a framework guarantee.

### Why TypeBox

One schema definition produces four artifacts: runtime validation, TypeScript types, OpenAPI documentation, and the JSON Schema used to validate smart-form payloads (D-028).

**Zod — rejected here specifically.** Better ergonomics, but its JSON Schema output is a conversion rather than its native form. Since smart forms compile field definitions to JSON Schema and validate them with the same engine as static routes, JSON Schema is the native currency of this system. TypeBox *is* JSON Schema.

**Swagger UI is disabled in production.** The OpenAPI document is a build artifact. In production the spec is served only to authenticated internal users, or not at all.

---

## 4. Authentication and cryptography

| Component | Version | Purpose |
|---|---|---|
| `@node-rs/argon2` | 2.x | Password hashing — argon2id |
| `jose` | 5.x | JWT signing and verification |
| `otpauth` | 9.x | TOTP for MFA |
| `node:crypto` | built-in | Random tokens, HMAC, `timingSafeEqual` |

**`@node-rs/argon2` over `argon2`:** the native-binding `argon2` package requires a compiler toolchain at install time, which breaks Alpine images and frustrates on-premise installs. `@node-rs/argon2` ships prebuilt Rust binaries. Same algorithm, far fewer support tickets.

**`jose` over `jsonwebtoken`:** actively maintained, modern crypto, strict algorithm handling. `jsonwebtoken` has a history of algorithm-confusion issues and looser defaults.

**Parameters:** argon2id, memory 19456 KiB, iterations 2, parallelism 1 — the OWASP baseline. Stored in config so they can be raised without a code change; existing hashes carry their own parameters and rehash on next successful login.

**Never used:** `bcrypt` (72-byte truncation, weaker against GPU attack), `md5`/`sha1` anywhere near a password, `Math.random()` for anything security-adjacent.

---

## 5. Background jobs

| Component | Version | Purpose |
|---|---|---|
| `pg-boss` | 10.x | Job queue on Postgres (D-016) |

Zero new infrastructure on-premise, and jobs enqueue in the same transaction as the state change that triggers them (ER-028). Accessed only through `QueuePort` (ER-011), so a later swap is an adapter change.

`pg-boss` owns its own schema (`pgboss`), separate from the application schema. Its tables are excluded from application RLS policies; access is controlled by grant instead.

**Six queue domains, six worker pools** (D-039), each with its own concurrency, priority, retry, and rate-limit policy. The worker deployable takes a domain argument — one process per domain in production, all six in one process locally.

**Tenant fairness requires a custom claim query** (D-040). pg-boss has no per-tenant concurrency control; the adapter caps in-flight jobs per tenant within each domain rather than taking the next N by age. This lives entirely in `platform/queue` — no handler is aware of it.

---

## 6. Storage, email, and cache adapters

| Port | Library | Version | Deployment |
|---|---|---|---|
| `StoragePort` | `@aws-sdk/client-s3` | 3.x | Hosted (S3), on-prem (MinIO — same API) |
| | `node:fs/promises` | built-in | On-prem filesystem |
| `MailPort` | `nodemailer` | 6.x | SMTP — universal, works on-prem |
| | provider SDK | — | Hosted, optional, behind the same port |
| `CachePort` | `lru-cache` | 11.x | In-process (D-017) |
| `ClockPort` | built-in | — | Injectable for tests |

**MinIO speaks the S3 API**, so one adapter implementation covers both hosted and a large share of on-premise installs. The filesystem implementation exists for customers who will not run object storage at all.

**File type validation:** `file-type` 19.x — magic-byte detection. The client-supplied content type and filename are never trusted (ER-050).

---

## 7. Observability

| Component | Version | Purpose |
|---|---|---|
| `pino` | 9.x | Structured JSON logging |
| `@opentelemetry/sdk-node` | 0.5x | Tracing |
| `@opentelemetry/exporter-trace-otlp-http` | 0.5x | OTLP export |
| `prom-client` | 15.x | Metrics |

**Pino** is the fastest mature Node logger and emits structured JSON natively. Its redaction feature is configured with an explicit path list covering every personal-data field (ER-048) — belt and braces alongside the rule that such data never reaches a log call in the first place.

**OpenTelemetry** rather than a vendor agent: an on-premise customer must be able to point traces at their own collector, or disable them entirely. Telemetry must never egress from customer premises by default (D-002).

**Prometheus metrics** over a hosted metrics SaaS, for the same reason.

---

## 8. Validation, utilities, and tooling

| Component | Version | Purpose |
|---|---|---|
| `date-fns` + `@date-fns/tz` | 4.x | Date arithmetic and time zones |
| `citext` (Postgres extension) | — | Case-insensitive email, in the database |
| `nanoid` | 5.x | Short public identifiers where a UUID is unwieldy |
| `dotenv` | 16.x | Local development only, never production |

**`date-fns` over Moment (deprecated) and Luxon:** tree-shakeable, immutable, and its explicit time-zone handling suits interview scheduling across US/HK/EU.

**No `lodash`.** Modern JavaScript covers nearly all of it. A utility genuinely needed goes in `shared/` with a test.

### Development tooling

| Component | Version | Purpose |
|---|---|---|
| `vitest` | 2.x | Test runner |
| `@testcontainers/postgresql` | 10.x | Real Postgres in tests (ER-053) |
| `supertest` or Fastify `inject` | — | HTTP-level tests — `inject` preferred, no socket needed |
| `eslint` + `typescript-eslint` | 9.x / 8.x | Linting |
| `eslint-plugin-boundaries` | 5.x | **Enforces ER-001 and ER-007 layer rules mechanically** |
| `prettier` | 3.x | Formatting |
| `husky` + `lint-staged` | 9.x / 15.x | Pre-commit gate |
| `@commitlint/cli` | 19.x | Conventional commits |
| `syncpack` | 13.x | Version consistency |

**`eslint-plugin-boundaries` is the important one.** It turns "controllers must not import repositories" and "no cross-module repository imports" from review conventions into build failures. Any rule enforceable by a linter should be, because an AI agent will otherwise violate it confidently and plausibly.

**Vitest over Jest:** native ESM and TypeScript, materially faster, and its watch mode suits a spec-then-test workflow.

### Ambient type packages

Appended during Phase 0 (T-001). These ship no runtime code — they are `.d.ts` declarations consumed only by `tsc`, and they are absent from the built image.

| Component | Version | Purpose |
|---|---|---|
| `@types/node` | 22.20.1 | Type declarations for the Node 22 standard library |
| `@types/pg` | 8.21.0 | Type declarations for `pg` (§2), which ships none of its own |

**Alternative considered:** doing without them. Not viable — `strict` with `noImplicitAny` (ER-012) makes every `node:` and `pg` import an error without declarations, and the alternative of hand-writing local declaration files means maintaining a second copy of an API surface that changes with each release.

**Version policy:** `@types/node` tracks the **runtime major**, not the newest release. It is pinned to 22.x because the runtime is Node 22 LTS (§1); installing 26.x would type-check the code against standard-library APIs that do not exist at runtime, which is a defect the compiler would actively conceal.

**Maintenance and licence:** both are DefinitelyTyped packages — MIT, published continuously, effectively zero bus-factor risk. Transitive tree: `@types/node` pulls only `undici-types`; `@types/pg` pulls `@types/node`. No runtime transitive dependencies.

### Commit message ruleset

Appended during Phase 0 (T-002). Dev-only, never in the built image.

| Component | Version | Purpose |
|---|---|---|
| `@commitlint/config-conventional` | 19.8.1 | The Conventional Commits ruleset `@commitlint/cli` (§8) validates against |

**Alternative considered:** declaring the rules inline in `commitlint.config.js`. Rejected — Conventional Commits is an external standard with roughly seventy type/case/length rules, well past the twenty-line threshold in ER-049, and a hand-copied ruleset silently drifts from the standard it claims to implement.

**Maintenance and licence:** MIT, same monorepo and release train as `@commitlint/cli`, so its major must be kept equal to the CLI's. Transitive tree: `@commitlint/types` and `conventional-changelog-conventionalcommits`, both dev-only.

---

## 9. Security tooling in CI

| Tool | Purpose |
|---|---|
| `pnpm audit` | Known vulnerabilities — build fails on high or critical |
| `osv-scanner` | Cross-ecosystem advisories, broader than npm audit alone |
| `gitleaks` | Secret detection on every commit |
| `semgrep` | SAST with custom rules — see below |
| Dependabot / Renovate | Automated dependency updates, grouped weekly |

**Custom Semgrep rules to write, one per class of mistake this architecture can make:**

1. Raw SQL string interpolation (ER-031)
2. `db.` or repository imports outside a repository file (ER-006)
3. `pg-boss`, S3, SMTP, or cache imports outside `platform/` (ER-011)
4. Object spread into a response mapper (ER-025)
5. `companyId` read from `req.body` or `req.query` (ER-023)
6. `SET ` without `LOCAL` in raw SQL (ER-018)
7. `===` comparison on a variable named `*token*` or `*hash*` (ER-052)

These are the seven mistakes most likely to appear in generated code and least likely to be caught by review, because each one looks completely normal in isolation.

---

## 10. Deployment

| Component | Purpose |
|---|---|
| Docker (multi-stage) | Both deployment targets |
| Docker Compose | On-premise, and local development |
| Kubernetes + Helm | Hosted product only |
| GitHub Actions | CI/CD |

**Two images, one codebase:** `findneo-api` and `findneo-worker` share a base and differ only in entrypoint (D-003).

**Base image:** `node:22-bookworm-slim`, not Alpine. musl versus glibc differences bite native modules, and the debugging cost on a customer's server exceeds the image size saving.

**Container rules:** non-root user, read-only root filesystem, no build toolchain in the runtime layer, healthcheck hitting `/health/ready`.

**On-premise delivery** is a Compose bundle: API, worker, Postgres 18, optional MinIO, plus a documented upgrade command that runs migrations explicitly with a backup step first.

---

## 11. Explicitly rejected

Recorded so the discussion is not reopened without new information.

| Technology | Why not |
|---|---|
| Prisma | RLS transaction binding (D-018, §2) |
| NestJS | Framework weight and duplicated schema definitions (§3) |
| Express | No schema-driven serialization; ER-025 becomes manual |
| Zod | JSON Schema is a conversion, not native (§3) |
| Redis (v1) | New infrastructure for every on-premise customer (D-016, D-017) |
| BullMQ | Requires Redis; cannot enqueue transactionally (D-016) |
| Kafka / RabbitMQ | Enormous operational burden for human-scale volume |
| MongoDB | No RLS, weak multi-table transactional guarantees |
| GraphQL | Field-level authorization becomes vastly harder; the masking model (D-025) is far cleaner over REST. The BFF (D-036) addresses the aggregation problem GraphQL is usually reached for |
| BFF as a separate deployable (v1) | Fourth on-premise container and a second auth surface for no benefit until a mobile client exists (D-036) |
| Per-tenant queues | Unbounded queue count; tenant fairness is solved in the adapter instead (D-040) |
| Serverless functions | Connection pooling and RLS session state both fight it; also unavailable on-premise |
| `bcrypt` | Weaker than argon2id; 72-byte truncation |
| `jsonwebtoken` | Algorithm-confusion history; `jose` is better maintained |
| `lodash` | Modern JS covers it |
| Moment.js | Deprecated by its own maintainers |

---

## 12. Dependency policy

**Adding a dependency requires** an entry in this document, a stated alternative considered, a maintenance check (last release, open critical issues, bus factor), a look at the transitive tree, and a licence check. Anything under twenty lines is written rather than installed (ER-049).

**Prohibited licences:** AGPL, SSPL, and any source-available licence restricting commercial use — on-premise distribution to customers makes this a live legal question, not a theoretical one.

**Version pinning:** exact versions in `package.json`, lockfile committed, `pnpm install --frozen-lockfile` in CI. No `^` or `~` ranges. A transitive update that changes behaviour must be a deliberate, reviewable commit.

**Review cadence:** monthly for updates, immediately for any advisory rated high or critical.
