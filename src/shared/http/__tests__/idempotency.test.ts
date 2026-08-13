import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../../shared/errors/app-error.js';
import { unsafeCompanyId, type CompanyId } from '../../../shared/types/ids.js';
import { DrizzleIdempotencyStore } from '../../../platform/db/idempotency-store.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../../../platform/db/unit-of-work.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';
import {
  IdempotencyInFlightError,
  abandonIdempotent,
  beginIdempotent,
  finishIdempotent,
  type IdempotencyDeps,
} from '../idempotency.js';

/**
 * T-010 against a real `idempotency_keys` (migration 001b).
 *
 * The concurrent-duplicate path is the reason this table exists: without it
 * idempotency only protects sequential retries, which is the easy half
 * (06 §7).
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
let deps: IdempotencyDeps;
const COMPANY = unsafeCompanyId('01920000-0000-7000-8000-0000000000a1');
const NOW = new Date('2026-08-13T09:00:00.000Z');

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 4, applicationName: 'idem-test' });
  deps = { uow: handle.uow, store: new DrizzleIdempotencyStore(), now: () => NOW };
}, 120_000);

afterAll(async () => {
  await handle.close();
  await database.drop();
});

const request = (key: string, body: unknown, companyId: CompanyId | null = COMPANY) => ({
  companyId,
  endpoint: 'POST /v1/jobs',
  key,
  body,
});

describe('07 §9: the four situations', () => {
  it('a new key proceeds', async () => {
    const decision = await beginIdempotent(deps, request('new-1', { title: 'a' }));
    expect(decision.kind).toBe('proceed');
  });

  it('the same key with the same body replays, without re-executing', async () => {
    const first = await beginIdempotent(deps, request('replay-1', { title: 'a' }));
    expect(first.kind).toBe('proceed');
    if (first.kind !== 'proceed') return;

    await finishIdempotent(deps, COMPANY, first.reservationId, 201, { id: 'job-1' });

    const second = await beginIdempotent(deps, request('replay-1', { title: 'a' }));
    expect(second).toEqual({ kind: 'replay', status: 201, body: { id: 'job-1' } });
  });

  it('the same key with a different body is 409 ERR_IDEMPOTENCY_CONFLICT', async () => {
    const first = await beginIdempotent(deps, request('conflict-1', { title: 'a' }));
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await finishIdempotent(deps, COMPANY, first.reservationId, 201, {});

    await expect(beginIdempotent(deps, request('conflict-1', { title: 'b' }))).rejects.toThrow(
      AppError,
    );
    try {
      await beginIdempotent(deps, request('conflict-1', { title: 'b' }));
    } catch (error) {
      expect((error as AppError).code).toBe('ERR_IDEMPOTENCY_CONFLICT');
      expect((error as AppError).status).toBe(409);
    }
  });
});

describe('07 §9: in-flight and missing key', () => {
  it('the same key while the first is in flight is 409 with Retry-After', async () => {
    await beginIdempotent(deps, request('inflight-1', { title: 'a' }));

    await expect(beginIdempotent(deps, request('inflight-1', { title: 'a' }))).rejects.toThrow(
      IdempotencyInFlightError,
    );
    try {
      await beginIdempotent(deps, request('inflight-1', { title: 'a' }));
    } catch (error) {
      expect((error as IdempotencyInFlightError).retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('a missing key is 422, never a silent pass', async () => {
    await expect(beginIdempotent(deps, { ...request('x', {}), key: undefined })).rejects.toThrow(
      AppError,
    );
    try {
      await beginIdempotent(deps, { ...request('x', {}), key: undefined });
    } catch (error) {
      expect((error as AppError).status).toBe(422);
    }
  });
});

describe('concurrent duplicates: exactly one proceeds', () => {
  it('two simultaneous requests with the same key do not both execute', async () => {
    const attempts = await Promise.allSettled([
      beginIdempotent(deps, request('race-1', { title: 'a' })),
      beginIdempotent(deps, request('race-1', { title: 'a' })),
    ]);

    const proceeded = attempts.filter(
      (a) => a.status === 'fulfilled' && a.value.kind === 'proceed',
    );
    expect(proceeded).toHaveLength(1);

    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(rejected).toHaveLength(1);
  });

  it('six simultaneous requests still yield exactly one', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, async () => beginIdempotent(deps, request('race-6', { n: 1 }))),
    );
    const proceeded = attempts.filter(
      (a) => a.status === 'fulfilled' && a.value.kind === 'proceed',
    );
    expect(proceeded).toHaveLength(1);
  });
});

describe('a failed handler must not lock the key for 24 hours', () => {
  it('abandoning a reservation lets the client retry', async () => {
    const first = await beginIdempotent(deps, request('abandon-1', { title: 'a' }));
    if (first.kind !== 'proceed') throw new Error('expected proceed');

    await abandonIdempotent(deps, COMPANY, first.reservationId);

    const retry = await beginIdempotent(deps, request('abandon-1', { title: 'a' }));
    expect(retry.kind).toBe('proceed');
  });
});

describe('scoping', () => {
  it('the same key on a different endpoint is a different reservation', async () => {
    const a = await beginIdempotent(deps, request('shared-key', { x: 1 }));
    const b = await beginIdempotent(deps, {
      ...request('shared-key', { x: 1 }),
      endpoint: 'POST /v1/candidates',
    });
    expect(a.kind).toBe('proceed');
    expect(b.kind).toBe('proceed');
  });

  it('ux_idem_scope is declared NULLS NOT DISTINCT (11 §3a)', async () => {
    /* Asserted against pg_index, not inferred from behaviour: if someone
       rebuilds this index without the clause, the behavioural test below
       would still pass for tenanted rows and quietly stop protecting
       pre-tenant ones. */
    const { Client } = await import('pg');
    const client = new Client({ connectionString: database.ownerUrl });
    await client.connect();
    try {
      const result = await client.query<{ nulls_not_distinct: boolean }>(
        `SELECT i.indnullsnotdistinct AS nulls_not_distinct
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'ux_idem_scope'`,
      );
      expect(result.rows[0]?.nulls_not_distinct).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('pre-tenant rows collide with each other — NULLS NOT DISTINCT', async () => {
    /* Without NULLS NOT DISTINCT on ux_idem_scope, PostgreSQL treats the two
       NULL company_ids as different and BOTH inserts succeed — silently
       disabling idempotency on exactly the unauthenticated surface (signup)
       where a duplicate submission is most likely. */
    const first = await beginIdempotent(deps, request('signup-1', { email: 'a' }, null));
    expect(first.kind).toBe('proceed');

    await expect(beginIdempotent(deps, request('signup-1', { email: 'a' }, null))).rejects.toThrow(
      IdempotencyInFlightError,
    );
  });
});
