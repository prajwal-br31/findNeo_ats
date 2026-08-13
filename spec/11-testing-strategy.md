# FindNeo — Testing Strategy

What must be tested, how, and what "done" means.

**Premise:** the highest-value tests here are not unit tests of business functions. They are tests that one tenant cannot see another's data, that a permission cannot be escalated, and that a race cannot bypass a cap. Those failures are unrecoverable reputationally; a wrong calculation is a bug fix.

---

## 1. Shape

```
        ╱ Isolation & authorization suite ╲   ← gates deployment
       ╱───────────────────────────────────╲
      ╱      Integration (real Postgres)    ╲  ← the bulk
     ╱───────────────────────────────────────╲
    ╱             Unit (pure logic)           ╲
   ╱───────────────────────────────────────────╲
```

Deliberately not the classic pyramid. Most logic here is inseparable from the database — RLS policies, triggers, partial indexes, row locks. A unit test with a mocked repository tests nothing that matters.

| Layer | Runs against | Covers |
|---|---|---|
| Unit | Nothing external | Pure functions: cursor encoding, masking resolution, EARS rule predicates, date arithmetic |
| Integration | Real Postgres via Testcontainers | Repositories, services, triggers, constraints, RLS |
| API | Fastify `inject` + real Postgres | Routes end to end: validation, permissions, errors, envelopes |
| Isolation | Real Postgres, two seeded tenants | Cross-tenant leaks, escalation, masking — **gates deploy** |
| Concurrency | Real Postgres, parallel requests | Caps, dedup, rotation, idempotency |

**No mocked database, ever** (ER-053). Adapters — mail, storage, AI — are faked through their ports, which is what ports are for.

---

## 2. Harness

**One container per suite file, template-restored per test.** Migrating a fresh database per test is far too slow; truncating between tests leaves sequence and trigger state behind.

```
beforeAll   → start Postgres 18 container, run migrations, seed platform
              defaults, snapshot as a template database
beforeEach  → CREATE DATABASE … TEMPLATE findneo_template  (fast)
afterEach   → drop
```

**Tenant fixtures.** Every suite gets two unrelated companies by default:

```ts
const { alpha, beta } = await seedTwoTenants();
// alpha: org with departments, jobs, users across every default role
// beta:  independent org — the control for every leak assertion
```

Two tenants is the default rather than an opt-in. A single-tenant fixture makes leak tests something you remember to write; two tenants makes their absence obvious.

**Acting as a role:**

```ts
const ctx = await actAs(alpha, 'hiring_manager', { departments: ['engineering'] });
const res = await api.get('/v1/jobs', ctx);
```

**Time is injected** through `ClockPort`. Cool-off windows, token expiry, and lockout are tested by advancing a fake clock, never by sleeping.

---

## 3. Mandatory tests

### Per feature (ER-054)

Every feature touching tenant data ships with:

1. Happy path.
2. **Cross-tenant leak:** act as alpha, assert beta's equivalent data is invisible through every route the feature adds — list, detail, expansion, export, webhook.
3. Permission denial: non-holder receives 403.
4. Row-scope denial: holder, out-of-scope row, receives **404** — not 403.
5. Validation: missing required, wrong type, unknown property, server-controlled field in the body.
6. Masking: masked field absent or null with `_masked`, for a non-holder.

A feature without item 2 is not done. It is not deferred, not tracked as debt, not merged.

### Per business rule (ER-055)

Every `BR-nnn` has at least one test naming it:

```ts
it('BR-057: rejects a second active application when the cap is 1', async () => { … });
```

**Rules marked DB additionally require a raw-SQL test** that attempts the violation directly against the database, bypassing the service:

```ts
it('BR-008 (DB): composite FK rejects cross-tenant department attachment', async () => {
  await expect(
    rawSql`INSERT INTO user_departments (user_id, department_id, company_id)
           VALUES (${alphaUser.id}, ${betaDept.id}, ${alpha.id})`
  ).rejects.toThrow(/foreign key/);
});
```

A database-enforced rule that only fails in the service is not database-enforced, however the spec describes it.

### Connection-pool reuse is mandatory in concurrency tests

Any test exercising tenant context must run **more transactions than the pool holds connections**, so a bound connection is provably reused by a later transaction. A single-connection test cannot detect GUC-reset behaviour, stale context, or cross-request leakage — the three failures that matter most (D-047).

The harness pool is deliberately small (two connections) so this property is cheap to obtain.

### Migrating the test database

`db:migrate` targets the development database. The harness needs its own path to apply migrations to `findneo_test` as the owner role. This is separate from the template-database restore: migrations build the template once; the restore clones it per test.

### Per concurrency rule (ER-057)

Every "at most N", "only if none exists", or "first wins" rule gets simultaneous requests:

```ts
it('BR-058: simultaneous submissions cannot both pass the cap', async () => {
  const results = await Promise.allSettled([submit(), submit()]);
  expect(results.filter(ok).length).toBe(1);
});
```

These catch the check-then-act races that single-threaded tests never will, and they are the reason BR-058 requires a row lock rather than a count.

---

## 4. The isolation suite

A separate suite that gates deployment. It runs on every pull request and blocks release on failure.

**Schema-level assertions** — these catch the table someone adds in three months and forgets:

```sql
-- every table with company_id has RLS enabled AND forced
SELECT c.relname FROM pg_class c
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id'
 WHERE c.relkind = 'r'
   AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
-- must return zero rows
```

Also asserted: every such table has at least one policy; every route in the OpenAPI output names a permission that exists in the catalog; `findneo_app` holds no `UPDATE` or `DELETE` grant on `audit_logs`.

**Behavioural assertions:**

| Test | Assertion |
|---|---|
| Unset context | Zero rows from every tenant table, not all rows |
| Platform row | `company_id IS NULL` invisible under every tenant context |
| Composite FK | Cross-tenant association rejected |
| Public role | Raw `SELECT * FROM jobs` as `findneo_public` returns no confidential or unpublished row |
| Agency isolation | Agency user cannot reach client internal jobs, other agencies' submissions, or any scorecard |
| Impersonation | Platform staff without an active grant receive 404; every impersonated read is audited |
| Escalation | `roles.assign` holder cannot grant a permission they lack |
| Confidential | Department membership alone does not reveal a confidential job |
| Anchoring | Interviewer cannot read peer scores before submitting |
| Masking depth | Masked field withheld through endpoint, expansion, export, webhook, **and audit read** |
| Refresh replay | Rotated token replay revokes the whole family |

The public-role test uses a **raw unfiltered `SELECT *`** deliberately: it proves the policy holds, not that one query happened to be written correctly.

---

## 5. Coverage

Line coverage is a weak signal and is not a gate. These are:

| Requirement | Threshold |
|---|---|
| Business rules with a citing test | **100%** |
| Routes with permission-denial and scope-denial tests | **100%** |
| Tenant-scoped features with a leak test | **100%** |
| DB-enforced rules with a raw-SQL test | **100%** |
| Concurrency rules with a parallel test | **100%** |
| Line coverage on `services/` and `repositories/` | 80%, reported not gated |

A custom CI check parses `03-business-rules.md`, extracts every `BR-nnn`, and fails if any lacks a citing test. Specs and tests drift silently otherwise.

---

## 6. What is not unit tested

Deliberately, to avoid tests that assert the implementation rather than the behaviour:

- **Controllers** — they validate, call one service, return. Covered by API tests.
- **Mappers** — covered by response schema validation and masking tests.
- **Repositories in isolation** — meaningless without RLS; covered by integration tests.
- **Fastify, Drizzle, pg-boss** — testing a dependency's own behaviour.

---

## 7. Fakes

| Port | Test implementation |
|---|---|
| `MailPort` | In-memory; assert recipients and template ids, never body text containing personal data |
| `StoragePort` | In-memory map; assert the object was written and is retrievable |
| `QueuePort` | Records enqueues; a helper drains them synchronously so a job's effects can be asserted in the same test |
| `CachePort` | Real LRU, cleared per test — **never bypassed**, because tenant-key correctness is exactly what must be tested |
| `ClockPort` | Controllable fake |

`QueuePort` is worth care: the fake must enqueue **inside the transaction** like the real one, so a rollback discards the job. A fake that enqueues eagerly hides the exact bug BR-100 exists to prevent.

---

## 8. Performance and load

Not gating, run before release:

| Scenario | Target |
|---|---|
| Authorization overhead | Sub-5ms per request |
| Job list, 100k applications | p95 under 200ms |
| Application list with masking | p95 under 300ms |
| Concurrent submissions | No cap violation, no deadlock |
| Worker throughput | Backlog drains under sustained enqueue |

Seeded with a realistic tenant-size distribution — a handful of large tenants alongside many small ones. Uniform seed data hides the index problems that only appear with skew.

---

## 9. CI pipeline

```
lint (eslint + boundaries)  ─┐
typecheck (tsc --noEmit)     ├─ parallel, fast fail
format check                 │
semgrep (7 custom rules)     │
gitleaks                     ┘
        ↓
unit + integration + API tests
        ↓
ISOLATION SUITE              ← blocks deploy on failure
        ↓
migration check (fresh + skip-version upgrade)
openapi regeneration (no diff)
business-rule coverage check
        ↓
pnpm audit + osv-scanner (fail on high/critical)
```

**Migration check runs twice:** once against an empty database, once upgrading from the previous release tag. On-premise customers skip versions, so a migration assuming the immediately previous release is running will break someone's install remotely (ER-032).

---

## 10. Definition of done

- [ ] Happy path tested
- [ ] Cross-tenant leak test written and passing
- [ ] Permission-denial (403) and row-scope-denial (404) tested
- [ ] Every `BR-nnn` touched has a citing test
- [ ] DB-enforced rules have a raw-SQL violation test
- [ ] Concurrency rules have a parallel test
- [ ] Masking tested through endpoint, expansion, export, webhook, and audit
- [ ] Validation tested: missing, wrong type, unknown property, server-controlled field
- [ ] Error responses match the catalog; no internals leaked
- [ ] Migration tested fresh **and** skip-version
- [ ] OpenAPI regenerates with no diff
- [ ] Isolation suite green
