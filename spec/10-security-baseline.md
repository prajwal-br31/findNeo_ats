# FindNeo — Security Baseline

The threat model and the control answering each threat. Controls carry `SEC-nnn` ids so code and tests can cite them.

**What this system holds:** identifiable personal data — names, contact details, employment history, compensation, and evaluative judgements about people — for multiple competing companies, in one database, across three jurisdictions, with an unauthenticated public write surface, and shipped to customers to run themselves.

Every control below follows from that sentence.

---

## 1. Trust boundaries

```
┌─ Internet ────────────────────────────────────────────────┐
│  Candidate (no account)   Public career site              │
└──────────────┬────────────────────────────────────────────┘
               │  unauthenticated, rate limited
┌──────────────▼────────────────────────────────────────────┐
│  API server                                               │
│    ├─ /v1/public/*      → findneo_public DB role          │
│    ├─ /v1/*             → findneo_app DB role             │
│    ├─ /v1/agency/*      → findneo_app, agency policies    │
│    └─ /v1/platform/*    → findneo_platform, audited       │
└──────────────┬────────────────────────────────────────────┘
               │
┌──────────────▼────────────────────────────────────────────┐
│  PostgreSQL 18 — RLS enabled and FORCED on every table    │
└───────────────────────────────────────────────────────────┘
```

**Boundaries that matter most:**

1. **Tenant ↔ tenant.** The primary risk. One leak destroys the product's credibility permanently.
2. **Agency ↔ client.** An agency sees a narrow projection of a client's data and must never see other agencies' work or internal evaluation.
3. **Public ↔ authenticated.** The career site is the only unauthenticated write path.
4. **Platform staff ↔ tenant data.** Internal access is a deliberate, audited action, never ambient.
5. **Field-level.** A user with legitimate row access may still be forbidden a field.

---

## 2. Tenant isolation

### SEC-001 — Isolation is enforced at three independent layers
| Layer | Mechanism |
|---|---|
| Database | RLS `ENABLE` + **`FORCE`**, policy on `company_id` |
| Repository | Explicit `company_id` filter in every query |
| Session | Tenant identity read only from the authenticated session |

Three layers because each fails differently: RLS fails silently on misconfiguration, application filters fail on developer omission, session binding fails on injection. None alone is sufficient.

### SEC-002 — `FORCE ROW LEVEL SECURITY` on every tenant table
Without `FORCE`, the table owner bypasses every policy. The application connects as `findneo_app`, which owns nothing.

### SEC-003 — Unset context yields zero rows
`current_setting('app.current_company_id', true)` returns NULL when unset; NULL comparison fails the predicate. The failure direction is "nothing", never "everything". Tested explicitly.

### SEC-004 — Tenant binding is parameterised and transaction-local
```sql
SELECT set_config('app.current_company_id', $1, true);
```
Never interpolated. Never `SET` without `LOCAL`. Never outside a transaction. Semgrep rule 6 enforces this.

### SEC-005 — Tenant context never lives in a global
Threaded through the call chain or held in `AsyncLocalStorage`. A module-level variable leaks across concurrent requests on Node's event loop — intermittently, under load, in production only.

### SEC-006 — Composite foreign keys on every cross-entity association
`(user_id, company_id) → users(id, company_id)`. A plain FK permits attaching a user to another tenant's department; the resulting join row lives legitimately in your own tenant, so **RLS cannot detect it**. Only the composite FK prevents it.

### SEC-007 — Cross-tenant access returns 404
403 confirms existence and enables enumeration. Applies to platform staff too.

### SEC-008 — Cache keys include the tenant
One process caches many tenants. An unkeyed entry is a cross-tenant leak. `CachePort` makes the tenant portion structurally required, not conventional.

### SEC-009 — Three database roles, least privilege
`findneo_app`, `findneo_public`, `findneo_platform`. None is superuser, none owns tables. `findneo_public` holds `SELECT` on published-job projections and `INSERT` on applications, and nothing else — so an authorization bug in the unauthenticated path has a hard floor under it.

---

## 3. Authentication

### SEC-010 — argon2id password hashing
Memory 19456 KiB, iterations 2, parallelism 1 (OWASP baseline). Parameters in config; existing hashes carry their own and rehash on next successful login. Never bcrypt, never a bare hash function.

### SEC-011 — Access token in memory, refresh token in an httpOnly cookie
Access token 15 minutes, held in memory only — never `localStorage`, which is readable by any injected script. Refresh token in an httpOnly, Secure, SameSite=Lax cookie, hashed at rest.

### SEC-012 — Refresh rotation with family revocation
Every refresh issues a new token and invalidates the old. Presenting an already-rotated token revokes the entire family — replay indicates theft, so the legitimate holder is logged out deliberately.

### SEC-013 — Access tokens carry no permission list
Identity, session, and tenant only. A baked-in permission list keeps a revoked permission live until expiry.

### SEC-014 — MFA mandatory for Super Admin
Enforced by database trigger, not application code. This account can reassign every permission in the tenant.

### SEC-015 — Uniform authentication responses
Identical response and comparable timing whether or not the account exists. Applies to login, password reset, and invitation lookup.

### SEC-016 — Inline lockout
`failed_login_count` and `locked_until` on `users`. Exponential backoff. There is no `login_attempts` table.

### SEC-017 — All tokens hashed at rest
Refresh, invitation, candidate action, agency portal, API keys. Compared with `timingSafeEqual`, never `===`.

### SEC-018 — CSRF protection on cookie-authenticated endpoints
Double-submit token on refresh and logout. SameSite=Lax alone is not sufficient for state-changing requests.

### SEC-019 — Candidates hold no credentials
Single-purpose, expiring, single-use tokens bound to one application and one action. No ambient authority beyond the encoded action.

---

## 4. Authorization

### SEC-020 — Fixed pipeline, no step skipped
Authenticate → bind tenant → capability → permission → row scope → field mask.

### SEC-021 — Fail closed at route registration
Every route declares **either** `permission: '<key>'` **or** `public: true` with a `publicReason` string. A route declaring neither **fails to register at boot**.

Absence is never interpreted as public. The opt-out is explicit, greppable, and small enough to review in full — a CI check asserts the count of `public: true` routes against a committed expected number, so a new one cannot appear unnoticed.

**Operational endpoints are not exempted — they are separated.** `/health/*` and `/metrics` run on a **second Fastify instance bound to loopback** on a different port, never registered on the public listener. This satisfies `12-observability-ops.md` §3 structurally rather than by allowlist, and removes the temptation to widen the exemption later.

### SEC-022 — Row scope evaluated in the query
Never a post-fetch filter. Filtering after load means the row was already read — visible in timing, visible in logs, and it invites reuse "just this once".

### SEC-023 — No negative permissions
Union of grants, only. A deny that overrides a grant makes effective access impossible to reason about and impossible to test exhaustively.

### SEC-024 — No privilege escalation through role management
A user may not grant a permission they do not hold. Without this, `roles.assign` is equivalent to Super Admin.

### SEC-025 — Agency sessions never rebind tenant context
An agency user's session is always scoped to the agency's own company; client data flows through `agency_engagements` joins with their own policies. Binding the client's tenant id would make a single tenant predicate expose the client's internal jobs, other agencies' candidates, and internal feedback.

### SEC-026 — Platform staff have no ambient tenant access
`company_id IS NULL` satisfies no tenant policy. Access requires explicit, time-boxed impersonation with a stated reason, audited and visible to the tenant's Super Admin.

---

## 5. Data protection

### SEC-030 — Masking at serialization, server-side only
The API never sends a value the caller may not see. Never send-and-hide.

### SEC-031 — Allowlist serialization
Response fields named explicitly and declared in a Fastify response schema. A new column cannot reach a response by accident — this is how password hashes and refresh tokens leak in practice.

### SEC-032 — Masking applies to audit entries
A viewer without permission for a field sees that it changed, by whom and when, with values masked. Otherwise the audit trail becomes a bypass of the control it exists to enforce. Field history is frequently more revealing than the field.

### SEC-033 — Personal data never leaves the system in logs or payloads
Not in logs, traces, error reports, job payloads, or webhook payloads. Job payloads carry ids; handlers re-read. Webhook consumers call the API with their own credentials and receive their own masking.

### SEC-034 — Anonymization, never hard deletion
Cool-off enforcement, commission attribution, and audit integrity all require the rows to survive erasure.

### SEC-035 — Encryption in transit and at rest
TLS 1.2+ everywhere, HSTS. Database and object storage encrypted at rest. MFA secrets encrypted with a key from the secret store, not the database.

### SEC-036 — Append-only audit
`findneo_app` holds `INSERT` and `SELECT` on `audit_logs` and no `UPDATE` or `DELETE`. Enforced by grant, so a bug cannot rewrite history.

---

## 6. Input handling

### SEC-040 — Validate at the edge, before business logic
TypeBox schemas on params, query, and body. `additionalProperties: false`. Unknown properties rejected, never ignored.

### SEC-041 — Server-controlled fields rejected in request bodies
`id`, `companyId`, `createdAt`, `createdBy`, `status`. Rejected, not accepted-and-ignored — that distinction is the whole of mass assignment.

### SEC-042 — Parameterised SQL, always
Including identifiers, including UUIDs, including values from your own database. Semgrep rule 1.

### SEC-043 — File validation by content
Magic bytes, not the filename or client-supplied content type. Size and page caps enforced before persistence. Client filenames never used in a storage key — path traversal.

### SEC-044 — Resumes stored outside the web root, served through the API
Never a public bucket URL. Every download goes through permission and row-scope checks and is audited.

### SEC-045 — Smart form payload caps
60 fields per version, 2,000 characters per text value, 32 KB total payload. The application form is filled through an unauthenticated endpoint — without caps a customer can configure a denial-of-service vector against their own public page.

### SEC-046 — SSRF defence on outbound requests
Webhook targets and any customer-supplied URL: resolve first, reject private and link-local ranges, no redirect following to a new host, timeout and size caps.

---

## 7. The public surface

### SEC-050 — Separate namespace, separate role, separate handlers
Never a shared handler with an authenticated route.

### SEC-051 — Visibility enforced by policy, not query
Published, non-confidential, correct tenant — all in the `findneo_public` RLS policy. Every future public endpoint inherits it. There is no filter to forget.

### SEC-052 — Narrow public projections
The public job object is built from scratch, not the internal object with fields removed. "Strip these fields" fails open when a column is added.

### SEC-053 — No enumeration
Unpublished, confidential, and nonexistent all return an identical 404.

### SEC-054 — Aggressive public rate limits
Per IP and per job. Bot-check integration point present from day one.

---

## 8. Operational security

### SEC-060 — Config validated at startup, secrets never in code
The process fails fast on a missing or malformed variable rather than discovering it at first use. `gitleaks` on every commit.

### SEC-061 — Security headers
Helmet defaults plus a strict CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. CORS allowlisted, never `*` on credentialed routes.

### SEC-062 — Hardened containers
Non-root, read-only root filesystem, no build toolchain in the runtime layer, pinned base image digest.

### SEC-063 — Errors leak nothing
No stack traces, SQL, constraint names, table names, upstream messages, paths, hostnames, or library versions. Detail is logged against a `traceId`.

### SEC-064 — Dependency and secret scanning in CI
`pnpm audit`, `osv-scanner`, `gitleaks`, `semgrep`. Build fails on high or critical.

### SEC-065 — Migrations are explicit, never automatic on boot
An on-premise customer must be able to run migrations as a deliberate operation with a backup taken first.

### SEC-066 — Load shedding and health checks
`under-pressure` returns 503 rather than degrading unpredictably. `/health/live` and `/health/ready` expose no internal detail.

---

## 9. On-premise specifics

### SEC-070 — Telemetry never egresses by default
OpenTelemetry points at a customer-controlled collector or nothing. No vendor agent phoning home.

### SEC-071 — No managed-service dependency
The customer runs Postgres and Node. Nothing else is required.

### SEC-072 — The RLS path is identical on-premise
No "skip RLS when self-hosted" branch. That branch would eventually run in production somewhere.

### SEC-073 — Customers hold their own secrets
No shared keys across installations. Signing keys, encryption keys, and database credentials are generated per install.

### SEC-074 — Upgrades are documented, versioned, and skip-safe
A migration must not assume the immediately previous release is running.

---

## 10. Threats and controls

| # | Threat | Controls |
|---|---|---|
| T-01 | Tenant A reads tenant B's data | SEC-001…009 |
| T-02 | Forgotten `WHERE company_id` | SEC-001, SEC-002 |
| T-03 | Cross-tenant association via a join table | **SEC-006** |
| T-04 | Tenant id injected via request body | SEC-001, SEC-041 |
| T-05 | SQL injection through tenant binding | SEC-004, SEC-042 |
| T-06 | Agency reads client internals | SEC-025 |
| T-07 | Agency reads a competitor's submissions | SEC-025, SEC-022 |
| T-08 | Confidential job exposed publicly | SEC-051 |
| T-09 | Public endpoint reads an unpublished job | SEC-009, SEC-051 |
| T-10 | Enumeration via response differences | SEC-007, SEC-015, SEC-053 |
| T-11 | Stolen refresh token replayed | SEC-012 |
| T-12 | XSS steals a token | SEC-011, SEC-061 |
| T-13 | Credential stuffing | SEC-010, SEC-016, rate limits |
| T-14 | Privilege escalation via role editing | SEC-024 |
| T-15 | Permission revoked but token still valid | SEC-013 |
| T-16 | Compensation visible to an unauthorised viewer | SEC-030, SEC-031 |
| T-17 | Masked field leaked through audit history | **SEC-032** |
| T-18 | New column silently appears in a response | SEC-031 |
| T-19 | Personal data in logs or job payloads | SEC-033 |
| T-20 | Malicious upload | SEC-043 |
| T-21 | Resume readable by URL guess | SEC-044 |
| T-22 | Mass assignment | SEC-041 |
| T-23 | Public form DoS | SEC-045, SEC-054 |
| T-24 | SSRF via webhook target | SEC-046 |
| T-25 | Platform staff browsing tenant data | SEC-026 |
| T-26 | Audit record altered | SEC-036 |
| T-27 | Erasure destroys commission evidence | SEC-034 |
| T-28 | On-prem telemetry leaks customer data | SEC-070 |
| T-29 | Shared secret across installations | SEC-073 |
| T-30 | Tenant context leaks between concurrent requests | **SEC-005** |

T-03, T-17, T-30, and T-01 are the four this architecture is most likely to get wrong, because each looks entirely normal in a code review.

---

## 11. Verification

**Gating the deployment pipeline:**

1. Every table with a `company_id` column has RLS enabled **and forced** — schema-level assertion, so a table added later cannot silently miss it.
2. Unset context returns zero rows from every tenant table.
3. Two-tenant leak suite across every route.
4. Composite FK rejects cross-tenant association.
5. `findneo_public` cannot read a confidential job, an unpublished job, or any user row — asserted with a raw `SELECT *`, so the test proves the policy, not the query.
6. Rotated refresh token replay revokes the family.
7. Masked fields absent through the endpoint, expansion, export, webhook, **and audit read**.
8. Every registered route names a permission in the catalog.
9. Semgrep rules 1–7 produce no findings.
10. `pnpm audit` and `osv-scanner` clean at high and critical.

**Periodic, not gating:** quarterly dependency review, annual penetration test before the first enterprise customer, and a documented incident response path with a named owner.

**Open:** breach notification obligations differ across US state law, Hong Kong PDPO, and GDPR. Needs legal input alongside O-006 (retention windows).
