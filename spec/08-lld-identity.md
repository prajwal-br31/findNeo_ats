# FindNeo — LLD: Identity & Access

Module: `src/modules/identity/`
Phase: 1 · Migrations: 001–015 · Spec basis: `06-data-model.md` §3–4, `04-permissions.md`, `10-security-baseline.md` §2–4

**This module is the foundation. Everything else trusts it.** Build it with Opus 5 and do not let a task be marked done on a green happy path alone.

---

## 1. Files

```
src/modules/identity/
  identity.routes.ts          route registration + permission metadata
  auth.controller.ts          signup, login, refresh, logout, MFA
  users.controller.ts
  roles.controller.ts
  departments.controller.ts
  invitations.controller.ts
  auth.service.ts             credentials, sessions, tokens
  users.service.ts
  roles.service.ts            + permission resolution
  departments.service.ts
  invitations.service.ts
  identity.repository.ts      users, sessions
  roles.repository.ts         roles, permissions, user_roles
  departments.repository.ts
  invitations.repository.ts
  identity.schemas.ts         TypeBox
  identity.mapper.ts          allowlist mappers
  identity.errors.ts
  identity.events.ts
  __tests__/
```

Shared, not in this module: `shared/authz/` holds the authorization pipeline, permission cache, and masking — used by every module.

---

## 2. Endpoints

### Public (unauthenticated)

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/v1/auth/signup` | — | Creates company + owner. Rate limit 3/hr/IP |
| POST | `/v1/auth/verify-email` | — | Consumes token |
| POST | `/v1/auth/login` | — | Rate limit 5/15min per IP **and** per email |
| POST | `/v1/auth/mfa/verify` | — | Completes an MFA challenge |
| POST | `/v1/auth/refresh` | — | Cookie-authenticated + CSRF |
| POST | `/v1/auth/logout` | — | Cookie-authenticated + CSRF |
| POST | `/v1/auth/password-reset/request` | — | Always 202, regardless of existence |
| POST | `/v1/auth/password-reset/confirm` | — | |
| GET | `/v1/invitations/{token}` | — | Preview only; no user data beyond company name |
| POST | `/v1/invitations/{token}/accept` | — | Creates the user |

### Authenticated

| Method | Path | Permission |
|---|---|---|
| GET | `/v1/users/current` | — (any authenticated) |
| PATCH | `/v1/users/current` | — |
| POST | `/v1/users/current/actions/enable-mfa` | — |
| POST | `/v1/users/current/actions/disable-mfa` | — |
| GET | `/v1/users` | `users.read` |
| GET | `/v1/users/{id}` | `users.read` |
| PATCH | `/v1/users/{id}` | `users.update` |
| POST | `/v1/users/{id}/actions/deactivate` | `users.deactivate` |
| POST | `/v1/users/{id}/actions/reactivate` | `users.update` |
| POST | `/v1/invitations` | `users.invite` |
| GET | `/v1/invitations` | `users.read` |
| POST | `/v1/invitations/{id}/actions/revoke` | `users.invite` |
| POST | `/v1/invitations/{id}/actions/resend` | `users.invite` |
| GET | `/v1/departments` | `departments.read` |
| POST | `/v1/departments` | `departments.create` |
| PATCH | `/v1/departments/{id}` | `departments.update` |
| DELETE | `/v1/departments/{id}` | `departments.delete` |
| POST | `/v1/departments/{id}/members` | `departments.members.manage` |
| DELETE | `/v1/departments/{id}/members/{userId}` | `departments.members.manage` |
| GET | `/v1/permissions` | `roles.read` |
| GET | `/v1/roles` | `roles.read` |
| POST | `/v1/roles` | `roles.create` |
| PATCH | `/v1/roles/{id}` | `roles.update` |
| DELETE | `/v1/roles/{id}` | `roles.delete` |
| GET | `/v1/users/{id}/roles` | `roles.read` |
| POST | `/v1/users/{id}/roles` | `roles.assign` |
| DELETE | `/v1/users/{id}/roles/{assignmentId}` | `roles.assign` |
| GET | `/v1/company` | `company.read` |
| PATCH | `/v1/company` | `company.update` |
| GET | `/v1/company/settings` | `company.read` |
| PATCH | `/v1/company/settings` | `company.settings.manage` |

### Platform (separate surface, `findneo_platform`)

| Method | Path | Permission |
|---|---|---|
| POST | `/v1/platform/auth/login` | — MFA mandatory, stricter limit |
| GET | `/v1/platform/companies` | `platform.companies.read` |
| POST | `/v1/platform/companies/{id}/actions/impersonate` | `platform.support.impersonate` |
| POST | `/v1/platform/impersonation/{id}/actions/end` | `platform.support.impersonate` |

---

## 3. Key flows

### Signup — one transaction

```
POST /v1/auth/signup
{ companyName, slug, countryCode, fullName, email, password }
```

1. Validate slug format; reject reserved (`www`, `api`, `app`, `admin`, `static`).
2. Check slug availability — **generic 422 on collision**, never "that company exists".
3. BEGIN:
   a. Insert `companies` (`status = 'pending_verification'`, `owner_user_id` NULL).
   b. `set_config('app.current_company_id', newCompanyId, true)` — **required**, or every subsequent insert fails RLS.
   c. Insert `users` (`status = 'pending'`, argon2id hash).
   d. Update `companies.owner_user_id`.
   e. Copy platform-default roles into the company. **Do not grant `super_admin` yet** — see below.
   f. Seed default settings, default pipeline template, default form templates.
   g. Insert email-verification token (hashed).
   h. Enqueue `notification.send` — **in this transaction**.
   COMMIT.
4. Return 201 with company id and a "verify your email" state. **No session issued** — MFA and verification come first.

**The circular FK** (`companies.owner_user_id` ↔ `users.company_id`) is handled by steps (a) and (d), not a deferrable constraint.

**MFA and the owner grant (D-050).** `trg_owner_requires_mfa` blocks granting `super_admin` to a user with `mfa_enabled = false`. Signup cannot therefore grant the role — the founding owner has not enrolled yet.

**The trigger is not exempted.** An exempted security trigger is a trigger with a hole, and the founding grant is precisely the one that matters most.

Instead the grant moves to the end of enrolment:

```
signup            → company 'pending_verification', user 'pending',
                    owner_user_id set, NO role grant
verify-email      → user 'active'
enable-mfa        → in ONE transaction: mfa_enabled = true,
                    grant super_admin, company → 'active'
```

A company therefore has an `owner_user_id` but no role-holder until MFA enrolment completes. That window is safe because the company is not `active` and no tenant-scoped route will serve it.

### Login

1. Rate limit per IP **and** per email.
2. Fetch by email — **always run argon2 verification**, against a dummy hash if the user is absent, so timing is uniform (SEC-015).
3. If `locked_until` is in the future → generic failure. Do not reveal the lock.
4. Verify password. On failure: increment `failed_login_count`, set `locked_until` on threshold, return the generic failure.
5. On success: reset counters, set `last_login_at`.
6. If `mfa_enabled` → return a short-lived MFA challenge token, **no session yet**.
7. Otherwise create the session and issue tokens.

Every failure path returns an identical body and a comparable duration.

### Token issuance

| Token | Lifetime | Transport |
|---|---|---|
| Access | 15 min | Response body → client memory |
| Refresh | 30 days | httpOnly, Secure, SameSite=Lax cookie |
| CSRF | session | Readable cookie + `X-CSRF-Token` header |

Access token claims: `sub`, `sid`, `cid` (company, null for platform staff), `cap` (capability), `iat`, `exp`, `jti`. **No permission list** (SEC-013).

### Refresh with family revocation

1. Read the cookie; verify CSRF double-submit.
2. Look up by hash. Absent → 401.
3. **If already rotated (`rotated_from_id` chain shows reuse) → revoke the entire `family_id`, return 401.**
4. If revoked or expired → 401.
5. Otherwise: create a new session row in the same family, revoke the old, set a new cookie, return a new access token.

Step 3 is the whole point. Replay means the token was stolen, so the legitimate holder is logged out deliberately.

### Permission resolution

```
user_roles → role_permissions → permission keys
```

Cached in-process keyed `(companyId, userId, rolesVersion)`. `rolesVersion` is a per-company counter bumped on any role change — so a revocation takes effect on the next request rather than after a TTL, without a cache flush.

**The tenant portion of the key is mandatory** (ER-024). One process caches many tenants.

### Impersonation

1. Platform staff with `platform.support.impersonate` posts a company id **and a stated reason**.
2. Creates a time-boxed grant (default 60 minutes).
3. Issues a session whose `cid` is the target company and which carries an impersonation marker.
4. Every request under it writes an audit entry with the grant id.
5. The tenant's Super Admin can see all impersonation activity.

Without an active grant, platform staff receive 404 on tenant data — never 403 (SEC-026).

---

## 4. Service contracts

```ts
interface AuthService {
  signup(input: SignupInput): Promise<SignupResult>;
  verifyEmail(token: string): Promise<void>;
  login(input: LoginInput, meta: RequestMeta): Promise<LoginResult>;
  verifyMfa(challengeToken: string, code: string, meta: RequestMeta): Promise<SessionResult>;
  refresh(refreshToken: string, meta: RequestMeta): Promise<SessionResult>;
  logout(refreshToken: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;   // always resolves
  confirmPasswordReset(token: string, password: string): Promise<void>;
}

interface RolesService {
  list(ctx: RequestContext): Promise<Role[]>;
  create(ctx: RequestContext, input: CreateRoleInput): Promise<Role>;
  assign(ctx: RequestContext, userId: UserId, input: AssignRoleInput): Promise<RoleAssignment>;
  revoke(ctx: RequestContext, userId: UserId, assignmentId: string): Promise<void>;
  resolvePermissions(ctx: RequestContext, userId: UserId): Promise<Set<PermissionKey>>;
}
```

`RequestContext` carries `companyId`, `userId`, `capability`, `permissions`, `departmentIds`, `traceId`, and the transaction client. **It never carries a Fastify request** (ER-004) — the worker calls these same services.

**Escalation guard** lives in `RolesService.assign` (BR-025): the actor's permission set must be a superset of the role being granted. Without it, `roles.assign` is Super Admin.

---

## 5. Transaction boundaries

| Operation | Boundary |
|---|---|
| Signup | One transaction, all seeding included |
| Login | One transaction — counters and session together |
| Refresh | One transaction — old revoked, new created atomically |
| Invitation accept | One transaction — user, role assignment, invitation status |
| Role assign | One transaction + `rolesVersion` bump |
| Department delete | One transaction — reassign or reject dependents first |

**Never two transactions where one will do.** A login that writes counters in one and the session in another can produce a session for a locked account.

---

## 6. Errors

| Situation | Code | Status |
|---|---|---|
| Bad credentials | `ERR_UNAUTHENTICATED` | 401 |
| Account locked | `ERR_UNAUTHENTICATED` | 401 |
| Unverified email | `ERR_UNAUTHENTICATED` | 401 |
| MFA needed | `ERR_MFA_REQUIRED` | 401 |
| Bad MFA code | `ERR_UNAUTHENTICATED` | 401 |
| Refresh reused | `ERR_UNAUTHENTICATED` | 401 |
| Slug taken | `ERR_VALIDATION_FAILED` | 422 |
| Weak password | `ERR_VALIDATION_FAILED` | 422 |
| Duplicate pending invitation | `ERR_DUPLICATE` | 409 |
| Escalation attempt | `ERR_FORBIDDEN` | 403 |
| Editing a platform role | `ERR_FORBIDDEN` | 403 |
| Department has members | `ERR_CONFLICT` | 409 |
| Owner without MFA | `ERR_MFA_REQUIRED` | 422 |
| Other tenant's user | `ERR_NOT_FOUND` | 404 |

The first five are deliberately identical from outside. Distinguishing them is an enumeration oracle.

---

## 7. Testing with Swagger

Swagger UI is served at `/docs` in development and staging only.

**Configuration required for cookie flows:**

```ts
await app.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: { persistAuthorization: true, withCredentials: true },
});
```

`withCredentials` matters: without it the browser will not send the httpOnly refresh cookie, and `/v1/auth/refresh` and `/v1/auth/logout` will always 401 from the UI. `persistAuthorization` keeps your bearer token across page reloads.

**Manual test flow:**

1. `POST /v1/auth/signup` → 201.
2. Dev only: verification token is written to the log; a dev-only `GET /v1/dev/last-email` endpoint (registered only when `NODE_ENV=development`) returns it.
3. `POST /v1/auth/verify-email`.
4. `POST /v1/auth/login` → copy `accessToken` into Swagger's **Authorize** box.
5. `GET /v1/users/current` → confirms the token works.
6. `POST /v1/invitations` for each role; accept them in a second browser profile.
7. Log in as a hiring manager; `GET /v1/users` → confirm the scoped result differs.
8. `POST /v1/auth/refresh` → confirm a new access token and a rotated cookie.
9. Call refresh again **with the old cookie value** → 401, and confirm every session in the family is revoked.

**Do not test tenant isolation through Swagger.** It requires two simultaneous tenants and raw-SQL assertions; that is the automated suite's job. Swagger is for shape and flow.

Add a `.http` file (`/docs/identity.http`) alongside so flows are repeatable without clicking.

---

## 8. Tests

**Unit:** password policy, token generation entropy, TOTP verification with clock skew, permission set union, cursor encoding.

**Integration:**
- Signup creates company, owner, roles, settings, and templates in one transaction
- Signup rollback leaves no partial company
- Lockout after N failures; unlock after the window (fake clock)
- Refresh rotation; family revocation on reuse
- Invitation accept creates the user with the right role
- Role assign bumps `rolesVersion` and takes effect on the next request
- Escalation guard rejects granting an unheld permission
- Platform-default role uneditable

**API:**
- Every endpoint: 401 unauthenticated, 403 without permission, 404 out of tenant
- Validation: missing, wrong type, unknown property, server-controlled field in body
- Login timing comparable for existing and non-existing accounts
- Error bodies match the catalog; no internals leak

**Isolation (gates deploy):**
- Alpha cannot read any beta user, department, role, or invitation
- Composite FK rejects attaching an alpha user to a beta department (BR-008)
- Platform user invisible under every tenant context
- Unset context returns zero rows from `users`, `departments`, `user_roles`
- Impersonation without a grant → 404; with a grant → audited

**Concurrency:**
- Two simultaneous signups on the same slug: exactly one succeeds
- Two simultaneous refreshes on one token: one succeeds, the family is revoked
- Tenant context does not leak across parallel requests (SEC-005)

---

## 9. Manual verification before Phase 2

- [ ] Sign up two companies with different slugs
- [ ] Invite one user per default role into company A
- [ ] Log in as each; confirm each sees a different `GET /v1/users` result
- [ ] Attempt to read a company B user id from a company A session → **404**
- [ ] Assign a hiring manager a department role; confirm it takes effect immediately
- [ ] Attempt to grant a permission you lack → **403**
- [ ] Enable MFA, log out, log back in through the challenge
- [ ] Replay an old refresh cookie → 401, and confirm you are logged out everywhere
- [ ] Check the log output contains **no email address, name, or token**
