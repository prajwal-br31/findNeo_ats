# FindNeo — Observability & Operations

Logging, tracing, metrics, deployment, backup, and upgrade — for both deployment targets.

**Constraint shaping everything here:** the same instrumentation ships to customers who run it themselves. Nothing may phone home, nothing may require a vendor account, and personal data must not reach any telemetry surface (SEC-070, SEC-033).

---

## 1. Logging

**Pino**, structured JSON, one line per event. Never `console.log`.

### Required fields

| Field | Notes |
|---|---|
| `level`, `time`, `msg` | |
| `traceId` | On every log line in a request or job |
| `companyId` | Tenant, where applicable |
| `userId` | Actor, where applicable |
| `route`, `method`, `statusCode`, `durationMs` | HTTP |
| `jobName`, `jobId`, `attempt` | Worker |

### Levels

| Level | Use |
|---|---|
| `fatal` | Process cannot continue — startup failure, unreachable database |
| `error` | Request or job failed unexpectedly. Always carries `traceId` |
| `warn` | Recoverable and notable — retry, rate limit, degraded dependency |
| `info` | Lifecycle: startup, shutdown, migration, job completion. **Not** per-request in production |
| `debug` | Development only |

Production runs at `info`. A per-request `info` line at scale is noise that hides the `error` lines.

### Redaction

Pino's `redact` is configured with an explicit path list — a second defence behind the rule that personal data never reaches a log call (SEC-033):

```
req.headers.authorization, req.headers.cookie,
*.password, *.passwordHash, *.token, *.tokenHash, *.refreshToken,
*.mfaSecret, *.email, *.phone, *.fullName,
*.salaryMin, *.salaryMax, *.currentCtc, *.expectedCtc,
*.rawText, *.comments, *.bodyRendered
```

**Never logged, under any level:** candidate names, emails, phone numbers, salary figures, resume text, scorecard comments, message bodies. Log the id; a reader with permission can look it up through the API.

**Error logs carry the full detail** — stack, SQL error code, constraint name — against the `traceId`. None of it reaches the response (SEC-063).

---

## 2. Tracing

**OpenTelemetry**, OTLP export. Auto-instrumentation for HTTP and Postgres, plus manual spans for the parts that matter.

| Span | Attributes |
|---|---|
| `http.request` | route, method, status, `company.id` |
| `authz.resolve` | permission count, cache hit or miss |
| `db.transaction` | statement count, duration |
| `job.execute` | job name, attempt, outcome |
| `queue.enqueue` | job name, in-transaction flag |
| `storage.*`, `mail.*` | adapter, outcome |

**Span attributes carry ids only.** A span attribute is telemetry; the same rule applies as to logs.

`authz.resolve` is instrumented specifically because `05-architecture-hld.md` §9 commits to sub-5ms authorization overhead, and that claim needs evidence rather than assertion.

**On-premise:** points at a customer-controlled collector, or is disabled entirely by config. Default is disabled.

---

## 3. Metrics

Prometheus format at `/metrics`, bound to an internal interface and never exposed publicly.

### Application

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | counter | route, method, status |
| `http_request_duration_seconds` | histogram | route, method |
| `authz_resolution_duration_seconds` | histogram | cache_hit |
| `authz_denials_total` | counter | reason (`permission`/`scope`/`capability`) |
| `db_transaction_duration_seconds` | histogram | |
| `db_pool_connections` | gauge | state |
| `queue_jobs_total` | counter | job_name, outcome |
| `queue_job_duration_seconds` | histogram | job_name |
| `queue_backlog_size` | gauge | job_name |
| `queue_dead_letter_total` | counter | job_name |
| `outbox_unpublished_age_seconds` | gauge | |
| `auth_failures_total` | counter | reason |
| `rate_limit_hits_total` | counter | surface |

**`outbox_unpublished_age_seconds` is the most important metric in this system.** A rising value means the relay has stalled — notifications are not sending, webhooks are not delivering, and AI requests are not leaving. Nothing else fails loudly when this breaks.

**`authz_denials_total` by reason** is a security signal. A spike in `scope` denials from one user is worth looking at.

**Never labelled by `companyId`** — tenant count is unbounded and would explode cardinality. Tenant-specific investigation goes through traces and logs.

### Alerts

| Alert | Condition |
|---|---|
| Outbox stalled | `outbox_unpublished_age_seconds > 300` |
| Queue backlog | backlog rising 15 minutes with no completions |
| Dead letters | any increase |
| Error rate | 5xx above 1% over 5 minutes |
| Auth failure spike | above baseline — credential stuffing |
| Pool exhaustion | waiting connections above zero, sustained |
| Disk | above 80% |
| Certificate expiry | within 14 days |

---

## 4. Health checks

| Endpoint | Purpose | Body |
|---|---|---|
| `/health/live` | Process alive | `{ "status": "ok" }` |
| `/health/ready` | Ready for traffic | status only |
| `/health/startup` | Migrations applied | status only |

`/health/ready` checks database connectivity and migration currency. It exposes **no version, hostname, dependency name, or internal detail** — health endpoints are unauthenticated and are a standard reconnaissance target.

`under-pressure` returns 503 when the event loop lags or memory exceeds threshold. Shedding load predictably beats degrading unpredictably.

---

## 5. Deployment — hosted

```
CDN → Load balancer → API (n replicas)
                       ↓
                    PgBouncer (transaction mode)
                       ↓
                 PostgreSQL 18 (+ read replica)
       Worker (1–2) ───┘
```

**Rolling deploy**, no downtime:

1. Run migrations as a **separate step**, before app rollout.
2. Migrations must be backward compatible with the currently running version — this is what makes rolling deploys safe (ER-032).
3. Roll API replicas; readiness gates each.
4. Roll workers after the API, so in-flight jobs finish against a known schema.

**Two-release destructive changes:** add and backfill in release N, remove in release N+1 after N is fully deployed. Never both in one release.

**Worker replicas stay low.** pg-boss uses row locks; more workers than the workload needs produces lock contention rather than throughput.

---

## 6. Deployment — on-premise

```
docker compose up -d
  findneo-api · findneo-worker · postgres:18 · minio (optional)
```

**Delivery bundle:** compose file, `.env.example`, an upgrade script, and a runbook.

**Upgrade procedure — documented, not assumed:**

```bash
./findneo-upgrade.sh v1.4.0
  1. Check current version
  2. BACKUP (pg_dump, verified non-empty)      ← refuses to continue if this fails
  3. Pull images
  4. Stop worker (drain in-flight jobs)
  5. Run migrations explicitly
  6. Start API, wait for readiness
  7. Start worker
  8. Post-upgrade health check
```

Migrations never run automatically on boot (SEC-065). A customer must be able to take a backup first and roll back.

**Skip-version upgrades must work.** A customer may go from v1.1 to v1.4 directly. CI tests an upgrade from the previous release tag; the release checklist additionally tests from two releases back.

**Per-install secrets** (SEC-073): the first-run script generates JWT signing keys, encryption keys, and database credentials locally. Nothing is shared across installations.

**Telemetry is off by default.** Enabling it points at the customer's own collector.

---

## 7. Backup and recovery

| | Hosted | On-premise |
|---|---|---|
| Full backup | Nightly | Nightly, script provided |
| PITR | WAL archiving | Documented, optional |
| Retention | 30 days | Customer's choice |
| Object storage | Versioned, replicated | Customer's responsibility, documented |

**Restore is rehearsed quarterly, not assumed.** An untested backup is a belief, not a control. The rehearsal restores to a scratch environment and runs the isolation suite against it — verifying both that the data came back and that RLS policies survived.

**Recovery targets:** RPO 24 hours (1 hour with PITR), RTO 4 hours hosted. On-premise targets are the customer's.

---

## 8. Runbooks

One page each, kept beside the alert that triggers them:

| Runbook | Covers |
|---|---|
| Outbox stalled | Diagnose the relay, drain safely, replay |
| Queue backlog | Identify the slow job, scale, dead-letter |
| Dead letter triage | Inspect payload (**ids only**), fix, requeue |
| Database failover | Promote replica, redirect, verify |
| Suspected tenant leak | **Contain first**, then investigate |
| Credential stuffing | Tighten limits, force rotation, notify |
| Failed migration | Roll back, restore, diagnose |
| Restore rehearsal | Full procedure with verification |

**Suspected tenant leak is the one to write first and rehearse.** It is the incident this architecture exists to prevent, and the correct first action — contain before investigating — is counterintuitive under pressure.

---

## 9. Audit versus logs

Persistently confused; they are different things with different guarantees.

| | `audit_logs` | Application logs |
|---|---|---|
| Purpose | Compliance and dispute evidence | Debugging |
| Storage | PostgreSQL, partitioned monthly | Log aggregator |
| Retention | Years | Weeks |
| Mutability | **Append-only, enforced by grant** | Rotated freely |
| Contains PII | Yes, masked on read | **Never** |
| Queried by | Customers, via API | Engineers |

A compliance question is answered from `audit_logs`. A debugging question is answered from logs. Neither substitutes for the other.

---

## 10. Environments

| | Development | Staging | Production |
|---|---|---|---|
| Swagger UI | ✅ | ✅ | ❌ |
| Log level | debug | info | info |
| Tracing | Console | Full | Full |
| Data | Seeded | Anonymized | Real |
| Rate limits | Relaxed | Production | Production |
| MFA | Optional | Enforced | Enforced |

**Staging data is anonymized, never a production copy.** A production dump in staging means production personal data under weaker access control — the most common way an otherwise careful system leaks.

---

## 11. Operational readiness

Before the first paying customer:

- [ ] Every alert in §3 configured with a runbook
- [ ] Restore rehearsed end to end
- [ ] On-premise install rehearsed from a clean machine
- [ ] Skip-version upgrade rehearsed
- [ ] Log output audited for personal data — grep a real day's logs
- [ ] `/metrics` and `/health/*` confirmed unreachable publicly
- [ ] Incident response path documented with a named owner
- [ ] Tenant-leak runbook rehearsed as a tabletop exercise
