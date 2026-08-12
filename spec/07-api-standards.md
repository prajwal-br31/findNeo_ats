# FindNeo — API Standards

The wire contract. Binding on every endpoint, including the public career site and internal administrative routes.

**Three consumers depend on this**: the web application, the public career site, and future integrations. None may be privileged over the others (D-019).

---

## 1. Base conventions

| Concern | Rule |
|---|---|
| Protocol | HTTPS only. HTTP redirects, HSTS enabled |
| Versioning | URI prefix `/v1/`. No header or query-parameter versioning |
| Path casing | `kebab-case` — `/v1/form-templates` |
| Body casing | `camelCase`, request and response |
| Resource names | Plural — `/v1/jobs`, `/v1/users` |
| Content type | `application/json; charset=utf-8`; `multipart/form-data` for uploads only |
| Errors | `application/problem+json` (§6) |
| Dates | ISO 8601 with offset — `2026-08-12T09:30:00Z`. Always UTC on the wire |
| Durations | ISO 8601 — `P6M`. Never a bare number |
| Money | `{ "amount": "120000.00", "currency": "USD" }` — **string** amount, never float |
| Ids | UUID string |
| Null vs absent | `null` = known empty. Absent = not provided (PATCH) or not permitted (masked, §8) |

### Documented singular exceptions

`/v1/company` (the caller's own tenant), `/v1/users/current` (the authenticated user). Both are single-instance resources where a plural form would be misleading. No further exceptions without a decision entry.

---

## 2. URI structure

```
/v1/{resource}                          collection
/v1/{resource}/{id}                     instance
/v1/{resource}/{id}/{sub-resource}      nested collection, one level only
/v1/{resource}/{id}/actions/{verb}      state transition
```

**Nesting stops at one level.** `/v1/jobs/{jobId}/applications` is fine; `/v1/jobs/{jobId}/applications/{appId}/interviews` is not — use `/v1/applications/{appId}/interviews`. Deep nesting produces unusable URLs and couples resources that should be addressable independently.

### Actions versus PATCH

`PATCH` is for simple field edits with no business rule beyond validation.

Anything that carries a rule, changes state, emits an event, or has side effects is an explicit action:

```
POST /v1/jobs/{id}/actions/publish
POST /v1/jobs/{id}/actions/close
POST /v1/applications/{id}/actions/advance
POST /v1/applications/{id}/actions/reject
POST /v1/applications/{id}/actions/transfer
POST /v1/users/{id}/actions/deactivate
```

**Why:** `PATCH { "status": "published" }` gives no place to carry a reason, no idempotency semantics, no natural permission boundary, and no honest audit verb. It also invites clients to believe status is freely assignable. Actions make the state machine explicit and each one gets its own permission.

**Prohibited:** verbs in resource paths (`/v1/getJobs`), actions on collections, `PUT` for partial updates.

---

## 3. Methods and status codes

| Method | Use | Success |
|---|---|---|
| `GET` | Read. Never has side effects | 200 |
| `POST` | Create, or an action | 201 create, 200 action, 202 async |
| `PATCH` | Partial update | 200 |
| `PUT` | Full replacement — rare | 200 |
| `DELETE` | Remove — usually soft | 204 |

| Code | Meaning here |
|---|---|
| 200 | Success with body |
| 201 | Created. `Location` header required |
| 202 | Accepted — async job started, body carries the run id |
| 204 | Success, no body |
| 400 | Malformed — unparseable, wrong type |
| 401 | Missing or invalid authentication |
| 403 | Authenticated, lacks permission **for a resource in your own tenant** |
| 404 | Not found, **or in another tenant** (ER-021) |
| 409 | Conflict — state machine violation, duplicate |
| 410 | Gone — expired single-use token |
| 413 | Payload too large |
| 415 | Unsupported media type |
| 422 | Well-formed but fails validation or a business rule |
| 429 | Rate limited. `Retry-After` required |
| 500 | Unhandled — never leaks detail |
| 503 | Shedding load or dependency unavailable |

**400 versus 422:** 400 means the request could not be understood. 422 means it was understood and rejected. A missing required field is 422; a body that is not JSON is 400.

**403 versus 404 (ER-021):** 403 confirms existence. Another tenant's resource is always 404 — no exceptions, including for platform administrators.

---

## 4. Request structure

**Path parameters:** identifiers only, always validated as UUID format before any lookup.

**Query parameters:**

| Parameter | Form | Notes |
|---|---|---|
| `limit` | integer | Default 25, max 100 |
| `cursor` | string | Opaque. Never constructed by a client |
| `sort` | `field:direction` | `createdAt:desc`. Allowlisted fields only |
| `q` | string | Free-text search |
| `status` | string or CSV | Filter |
| `include` | CSV | Expansion, allowlisted (§5) |

Filter parameters are named after the field they filter. Unknown query parameters are **rejected**, not ignored (ER-036) — silent acceptance hides client bugs.

**Headers:**

| Header | Direction | Purpose |
|---|---|---|
| `Authorization: Bearer <jwt>` | in | Access token |
| `Idempotency-Key` | in | Required on side-effecting POST (§9) |
| `X-Request-Id` | in/out | Client-supplied or generated; echoed |
| `X-Company-Slug` | in | Public career site only — never trusted for tenant scoping on authenticated routes (ER-023) |
| `X-Capability` | in | `organization` or `agency` — selects view for a dual-capacity company |
| `Retry-After` | out | On 429 and 503 |

**Bodies:** `additionalProperties: false` everywhere. Server-controlled fields (`id`, `companyId`, `createdAt`, `createdBy`, `status`) are rejected if present in a create or update body — accepting and ignoring them is how mass-assignment bugs are born.

---

## 5. Response structure

### Single resource

Returned bare, not wrapped. A wrapper on single resources adds a level of nesting to every client access for no benefit.

```json
{
  "id": "0192f3a1-...",
  "title": "Senior Backend Engineer",
  "status": "open",
  "department": { "id": "0192f...", "name": "Engineering" },
  "createdAt": "2026-08-12T09:30:00Z"
}
```

### Collections

```json
{
  "data": [ { "id": "...", "title": "..." } ],
  "pagination": {
    "nextCursor": "eyJpZCI6IjAxOTJm...",
    "hasMore": true,
    "limit": 25
  }
}
```

`data` and `pagination` only. **No total count** — an accurate count requires a second scan that dominates query cost on large tenants. Where a count is genuinely needed, it is a separate explicit endpoint the client opts into.

### Cursor pagination (D-023)

Cursor encodes the sort key and the id of the last row, base64url. Opaque to clients — the encoding may change without notice. Never offset: it skips and duplicates rows under concurrent writes and degrades on deep pages.

Sorting is always on `(sortField, id)` so ordering is total and the cursor is unambiguous.

### Async operations (202)

```json
{
  "runId": "0192f3a1-...",
  "status": "queued",
  "pollUrl": "/v1/resume-parsing-runs/0192f3a1-..."
}
```

Used for resume parsing, bulk import and export, and ranking runs (ER-045).

### Expansion

`?include=department,hiringTeam`. Allowlisted per endpoint, one level deep, never nested. Every expansion is subject to the same permission and masking rules as its own endpoint — expansion is never a way to read something otherwise forbidden.

### Reserved response field names

`_masked` (§8) and `_links`. No other underscore-prefixed field is permitted.

---

## 6. Errors

RFC 7807, extended (D-021).

```json
{
  "type": "https://errors.findneo.com/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "code": "ERR_VALIDATION_FAILED",
  "detail": "One or more fields are invalid.",
  "instance": "/v1/jobs",
  "traceId": "0192f3a1c4d27e8b",
  "fields": [
    { "path": "/title", "code": "ERR_FIELD_REQUIRED", "message": "Title is required." },
    { "path": "/salaryMax", "code": "ERR_FIELD_RANGE", "message": "Must be at least salaryMin." }
  ]
}
```

**`code` is the contract.** Clients branch on `code`, never on `title` or `detail`, which are human-facing and may be reworded or localised at any time.

**`fields[].path` is a JSON Pointer** into the request body, so a form maps errors onto inputs without parsing prose. This is the single most expensive detail to change once clients exist.

**`traceId` appears on every error**, including 500, and correlates to logs and traces.

### Error code catalog

Stable identifiers. Adding one is routine; changing the meaning of one is a breaking change.

| Code | Status | Meaning |
|---|---|---|
| `ERR_MALFORMED_REQUEST` | 400 | Unparseable |
| `ERR_UNAUTHENTICATED` | 401 | Missing or invalid token |
| `ERR_TOKEN_EXPIRED` | 401 | Access token expired — refresh |
| `ERR_MFA_REQUIRED` | 401 | MFA challenge outstanding |
| `ERR_FORBIDDEN` | 403 | Lacks permission |
| `ERR_CAPABILITY_MISMATCH` | 403 | Wrong view for this resource |
| `ERR_NOT_FOUND` | 404 | Absent, or another tenant |
| `ERR_TOKEN_CONSUMED` | 410 | Single-use token already used |
| `ERR_CONFLICT` | 409 | Generic state conflict |
| `ERR_INVALID_TRANSITION` | 409 | Not permitted by the state machine |
| `ERR_DUPLICATE` | 409 | Uniqueness violation |
| `ERR_IDEMPOTENCY_CONFLICT` | 409 | Key reused with a different body |
| `ERR_PAYLOAD_TOO_LARGE` | 413 | Exceeds limit |
| `ERR_UNSUPPORTED_MEDIA_TYPE` | 415 | Rejected file type |
| `ERR_VALIDATION_FAILED` | 422 | Schema validation failed |
| `ERR_BUSINESS_RULE_VIOLATION` | 422 | Named rule violated — `detail` cites `BR-nnn` |
| `ERR_APPLICATION_CAP_REACHED` | 422 | BR — concurrent application cap |
| `ERR_RATE_LIMITED` | 429 | Too many requests |
| `ERR_INTERNAL` | 500 | Unhandled |
| `ERR_SERVICE_UNAVAILABLE` | 503 | Dependency down or shedding |

### What never appears in an error (ER-038)

Stack traces, SQL, constraint names, table or column names, upstream provider messages, file paths, internal hostnames, library versions. Detail is logged against the `traceId` and returned to nobody.

**Enumeration safety:** authentication, password reset, and invitation-lookup failures return an identical response and take comparable time whether or not the account exists.

---

## 7. OpenAPI

Generated from TypeBox route schemas at build time by `@fastify/swagger`. **Never hand-edited** — it is a build output.

Every route declares: `operationId`, `summary`, `tags`, `security`, parameter schemas, request body schema, a response schema per status code, and the required permission in the description.

**CI gates:**
1. Regeneration produces no diff — a stale committed spec fails the build.
2. Every route has a response schema. A route without one cannot serialize safely (ER-035).
3. Breaking-change detection against the previous release; a breaking change requires an explicit label on the pull request.

Swagger UI is served in development and staging only. In production the document is available to authenticated internal users or not at all.

---

## 8. Field masking on the wire (D-025)

Masking happens at serialization, server-side, after row access resolves. **The API never sends a value the caller may not see.**

Two representations, chosen per field:

**Omitted** — the field is absent. Used where existence itself is sensitive.

**Nulled with a marker** — used where the client should show a "restricted" affordance:

```json
{
  "id": "0192f3a1-...",
  "title": "Senior Backend Engineer",
  "salaryMin": null,
  "salaryMax": null,
  "_masked": ["salaryMin", "salaryMax"]
}
```

`_masked` lists which fields were withheld, so a client distinguishes "restricted" from "not set" without inferring.

**Applies identically to:** collection items, expanded sub-resources, exports, webhook payloads, and **audit entries**. A viewer without permission for a field sees that it changed, by whom and when, with values masked. Otherwise the audit trail becomes a bypass of the control it exists to enforce.

**Never:** send the value with a flag telling the client to hide it. Never rely on a client to enforce visibility.

---

## 9. Idempotency

Required on every side-effecting POST: creates, actions, invitations, uploads (ER-040).

Client sends `Idempotency-Key: <uuid>`. The server stores the key with a hash of the request body and the response, scoped to `(company_id, endpoint, key)`, retained 24 hours.

| Situation | Behaviour |
|---|---|
| New key | Process, store, return |
| Same key, same body hash | Return the stored response, do not re-execute |
| Same key, different body | 409 `ERR_IDEMPOTENCY_CONFLICT` |
| Same key, first request in flight | 409 with `Retry-After` |

Missing key on a required endpoint is 422, not a silent pass. Retries are normal; duplicates are not — a duplicate offer, invitation, or commission attribution is a real business incident.

---

## 10. Rate limiting

| Surface | Limit |
|---|---|
| Authentication | 5 / 15 min per IP + per email |
| Signup | 3 / hour per IP |
| Token refresh | 30 / hour per session |
| Public career site read | 100 / min per IP |
| Public application submit | 5 / hour per IP, 20 / hour per job |
| Authenticated general | 300 / min per user |
| Bulk and export | 10 / hour per company |

Headers on every response: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; plus `Retry-After` on 429.

Limits are per-instance in v1 (in-process counters, D-017). Distributed limiting arrives with Redis if the hosted product needs it — never a requirement pushed onto on-premise customers.

---

## 11. Webhooks and events (D-031)

Emitted via the transactional outbox, relayed by the worker.

```json
{
  "id": "0192f3a1-...",
  "type": "application.stage_changed",
  "version": 1,
  "occurredAt": "2026-08-12T09:30:00Z",
  "companyId": "0192f3a1-...",
  "data": {
    "applicationId": "0192f...",
    "jobId": "0192f...",
    "fromStageId": "0192f...",
    "toStageId": "0192f..."
  }
}
```

**Payloads carry ids and metadata, never personal data** (ER-048). A consumer that needs the candidate's name calls the API with its own credentials and gets its own permission and masking applied. A webhook is not a way to receive data the recipient could not otherwise read.

**Delivery:** at-least-once, exponential backoff (1m, 5m, 30m, 2h, 12h), then dead-lettered. Signed with HMAC-SHA256 over the raw body in `X-FindNeo-Signature`, with a timestamp to prevent replay. Consumers must be idempotent on event `id`.

Event types are versioned. A breaking change to a payload is a new `version`, not an edit.

---

## 12. The public surface

Career site routes are separate in every respect (D-026): their own namespace, their own database role, their own rate limits, and **never a shared handler with an authenticated route**.

```
GET  /v1/public/{companySlug}/jobs
GET  /v1/public/{companySlug}/jobs/{jobId}
GET  /v1/public/{companySlug}/jobs/{jobId}/form
POST /v1/public/{companySlug}/jobs/{jobId}/applications
```

- Tenant is resolved from `{companySlug}`, never from a session or header.
- Responses are a deliberately narrow public projection — never the internal job object with fields stripped, because "strip these fields" fails open when a new column is added.
- Confidential and unpublished jobs are excluded by the `findneo_public` RLS policy, not by the query.
- No enumeration: an unpublished, confidential, or nonexistent job all return an identical 404.

---

## 13. Compliance checklist

Every new endpoint must satisfy all of these before merge:

- [ ] Path is plural, kebab-case, under `/v1/`, nested at most one level
- [ ] State transitions use `actions/{verb}`, not `PATCH`
- [ ] TypeBox schemas declared for params, query, body, and **every** response status
- [ ] `additionalProperties: false`; server-controlled fields rejected in bodies
- [ ] Collections use cursor pagination with the standard envelope
- [ ] Errors use the catalog; no internals leak
- [ ] Cross-tenant access returns 404, never 403
- [ ] Side-effecting POST requires `Idempotency-Key`
- [ ] Masking applied at serialization, including expansions
- [ ] Required permission named in the OpenAPI description
- [ ] Rate limit assigned
- [ ] Events emitted through the outbox, ids only
- [ ] OpenAPI regenerated with no diff
