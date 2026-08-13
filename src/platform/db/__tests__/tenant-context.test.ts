import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import { unsafeCompanyId } from '../../../shared/types/ids.js';
import { TxScopeError, unwrapTxScope } from '../tx-scope.js';
import { TenantContextError, tenantBindingStatement } from '../unit-of-work.js';

import { setUpProbeDatabase, type ProbeDatabase } from './support/probe-database.js';

/**
 * T-007. The Phase 0 gate turns on two of these: unset context must return
 * ZERO rows, and tenant context must not escape its request under concurrent
 * load (SEC-005) — tested in parallel, never sequentially.
 *
 * Also covers 06 §10 items 1, 2 and 9.
 *
 * This fixture surfaced both corrections in D-047: `FORCE ROW LEVEL SECURITY`
 * applies to the table owner (resolved by BYPASSRLS on the migrator), and a
 * transaction-local GUC reverts to `''` rather than becoming undefined
 * (resolved by `nullif` in the canonical policy). It seeds before enabling
 * RLS, which is the order a fixture wants regardless.
 */

let probe: ProbeDatabase;
let uow: UnitOfWorkPort;
/* If beforeAll fails there is nothing to tear down, and crashing here would
   bury the message explaining why the suite could not start. */
let started = false;

beforeAll(async () => {
  probe = await setUpProbeDatabase();
  uow = probe.app.uow;
  started = true;
});

afterAll(async () => {
  if (started) await probe.teardown();
});

/**
 * Returns null when no tenant is bound.
 *
 * `''` and NULL both mean unbound: a transaction-local GUC reverts to the
 * empty string when its transaction ends rather than becoming undefined, so a
 * connection that has served a bound transaction reports `''` afterwards.
 */
async function boundCompanyId(scope: TxScope): Promise<string | null> {
  const result = await unwrapTxScope(scope).execute<{ current: string | null }>(
    sql`select nullif(current_setting('app.current_company_id', true), '') as current`,
  );
  return result.rows[0]?.current ?? null;
}

async function visibleLabels(scope: TxScope): Promise<string[]> {
  const result = await unwrapTxScope(scope).execute<{ label: string }>(
    sql`select label from rls_probe order by label`,
  );
  return result.rows.map((row) => row.label);
}

describe('set_config is parameterised and transaction-local', () => {
  it('ER-031/SEC-042: the tenant id is a bind parameter, never SQL text', () => {
    const companyId = unsafeCompanyId('01920000-0000-7000-8000-0000000000a1');
    const query = new PgDialect().sqlToQuery(tenantBindingStatement(companyId));

    expect(query.params).toContain(companyId);
    expect(query.sql).not.toContain(companyId);
    expect(query.sql).toMatch(/set_config\(\$\d+, \$\d+, true\)/);
  });

  it('ER-018: the binding does not survive its transaction', async () => {
    await uow.withTenant(unsafeCompanyId(probe.alpha), async (tx) => {
      expect(await boundCompanyId(tx)).toBe(probe.alpha);
    });

    // withoutTenant throws if anything is still bound on the reused connection.
    await expect(uow.withoutTenant(boundCompanyId)).resolves.toBeNull();
  });
});

describe('unset context returns zero rows, not all rows', () => {
  it('06 §10.1: the rows exist — control, so a zero count cannot pass vacuously', () => {
    // Counted by the owner before FORCE was enabled; see probe-database.ts.
    expect(probe.seededCount).toBe(3);
  });

  it('SEC-003: findneo_app with no context bound sees zero rows', async () => {
    // Raw pg, deliberately not our Unit of Work: this must prove the policy
    // holds, not that our own abstraction happens to be written correctly.
    const result = await probe.appPool.query<{ count: string }>(
      'select count(*)::text as count from rls_probe',
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it('SEC-003: withoutTenant sees zero rows for the same reason', async () => {
    const labels = await uow.withoutTenant(visibleLabels);
    expect(labels).toEqual([]);
  });

  it('D-001: a bound context sees only its own tenant', async () => {
    const alpha = await uow.withTenant(unsafeCompanyId(probe.alpha), visibleLabels);
    const beta = await uow.withTenant(unsafeCompanyId(probe.beta), visibleLabels);
    expect(alpha).toEqual(['alpha row']);
    expect(beta).toEqual(['beta row']);
  });

  it('06 §10.2 / D-005: a company_id IS NULL row is invisible under every tenant context', async () => {
    for (const companyId of [probe.alpha, probe.beta]) {
      const labels = await uow.withTenant(unsafeCompanyId(companyId), visibleLabels);
      expect(labels).not.toContain('platform row');
    }
  });

  it('SEC-042: an injection-shaped company id widens nothing', async () => {
    const attempt = uow.withTenant(unsafeCompanyId("' or true--"), visibleLabels);
    await expect(attempt).rejects.toThrow();
  });
});

describe('tenant context cannot leak across concurrent requests (SEC-005)', () => {
  it('gate: parallel transactions each see only their own tenant', async () => {
    const order = [probe.alpha, probe.beta, probe.beta, probe.alpha, probe.alpha, probe.beta];

    const results = await Promise.all(
      order.map(async (companyId) =>
        uow.withTenant(unsafeCompanyId(companyId), async (tx) => {
          // Two await points inside the transaction force interleaving, and the
          // pool is smaller than the concurrency so connections are reused.
          const seen = await boundCompanyId(tx);
          const labels = await visibleLabels(tx);
          return { companyId, seen, labels };
        }),
      ),
    );

    for (const result of results) {
      expect(result.seen).toBe(result.companyId);
      expect(result.labels).toHaveLength(1);
      expect(result.labels[0]).toBe(result.companyId === probe.alpha ? 'alpha row' : 'beta row');
    }
  });

  it('a rolled-back transaction leaves no binding behind', async () => {
    const failure = uow.withTenant(unsafeCompanyId(probe.alpha), () =>
      Promise.reject(new Error('rollback')),
    );
    await expect(failure).rejects.toThrow('rollback');
    await expect(uow.withoutTenant(boundCompanyId)).resolves.toBeNull();
  });
});

describe('TxScope cannot be forged or outlive its transaction', () => {
  it('a scope used after its transaction has ended throws', async () => {
    let escaped: TxScope | undefined;
    await uow.withTenant(unsafeCompanyId(probe.alpha), (tx) => {
      escaped = tx;
      return Promise.resolve();
    });

    expect(escaped).toBeDefined();
    expect(() => unwrapTxScope(escaped as TxScope)).toThrow(TxScopeError);
  });

  it('a hand-built object is not a scope', () => {
    expect(() => unwrapTxScope({} as unknown as TxScope)).toThrow(TxScopeError);
  });

  it('TenantContextError is exported for callers that need to distinguish it', () => {
    expect(new TenantContextError('x')).toBeInstanceOf(Error);
  });
});

describe('schema-level guard (06 §10.9)', () => {
  it('every table with a company_id column has RLS enabled AND forced', async () => {
    const result = await probe.ownerPool.query<{ relname: string }>(`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
       WHERE c.relkind = 'r' AND n.nspname = 'public'
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    `);
    expect(result.rows.map((row) => row.relname)).toEqual([]);
  });
});
