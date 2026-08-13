import { sql } from 'drizzle-orm';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigValidationError, loadConfig } from '../../platform/config/config.js';
import type { Config } from '../../platform/config/config.types.js';
import { unwrapTxScope } from '../../platform/db/tx-scope.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../../platform/db/unit-of-work.js';
import { installQueueSchema } from '../../platform/queue/install.js';
import { PgBossQueue } from '../../platform/queue/pg-boss-queue.js';
import { deadLetterQueue } from '../../platform/queue/queue-policies.js';
import { QUEUE_DOMAINS } from '../../shared/ports/queue.js';
import { unsafeCompanyId } from '../../shared/types/ids.js';
import { createTestDatabase, type TestDatabase } from '../../testing/harness/test-database.js';
import { buildRegistry, startWorkers, JobRegistrationError, type WorkerFleet } from '../worker.js';

/**
 * T-013 — the worker fleet.
 *
 * The two properties worth real infrastructure: a handler runs with tenant
 * context already bound (ER-043), and a job that keeps failing ends up
 * somewhere visible instead of retrying forever (ER-044). Both are asserted
 * against the database and against pg-boss's own tables, not against a fake.
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
let boss: PgBoss;
let queue: PgBossQueue;
let fleet: WorkerFleet;

const COMPANY = unsafeCompanyId('01920000-0000-7000-8000-0000000000b1');

/** Resolves when the worker has seen the job, so tests need no sleeps. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const boundTenant = deferred<string | null>();
const failures = deferred<'exhausted'>();
let failureCount = 0;

function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({ ...process.env, NODE_ENV: 'test', ...overrides });
}

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 6, applicationName: 'worker-it' });
  await installQueueSchema(database.ownerUrl);

  boss = new PgBoss({ connectionString: database.appUrl, schema: 'pgboss', supervise: true });
  await boss.start();
  queue = new PgBossQueue(boss);

  fleet = await startWorkers({
    boss,
    uow: handle.uow,
    config: testConfig({ WORKER_DOMAINS: 'system,documents' }),
    registry: buildRegistry({
      system: {
        /* Reads the GUC the RLS policies read. If binding did not happen, this
           comes back empty and the assertion fails — the handler is not asked
           to take the worker's word for it. */
        'tenant.probe': async ({ tx }) => {
          const result = await unwrapTxScope(tx).execute<{ bound: string | null }>(
            sql`select current_setting('app.current_company_id', true) as bound`,
          );
          boundTenant.resolve(result.rows[0]?.bound ?? null);
        },
      },
      documents: {
        'always.fails': () => {
          failureCount += 1;
          /* documents allows 3 retries, so the 4th delivery is the last. */
          if (failureCount > 3) failures.resolve('exhausted');
          return Promise.reject(new Error('permanent failure'));
        },
      },
    }),
  });
}, 240_000);

afterAll(async () => {
  await fleet.stop();
  await handle.close();
  await database.drop();
});

describe('05 §5: the domain list is configuration', () => {
  it('serves only the configured domains', () => {
    expect(fleet.domains).toEqual(['system', 'documents']);
  });

  it('`all` means all six, which is the on-premise single-process fleet', () => {
    expect(testConfig({ WORKER_DOMAINS: 'all' }).workerDomains).toEqual(QUEUE_DOMAINS);
  });

  it('an unknown domain fails the boot rather than silently serving fewer', () => {
    /* The failure mode this prevents: `WORKER_DOMAINS=comunication` starts a
       healthy-looking process while every email sits unclaimed forever. */
    let problems: readonly string[] = [];
    try {
      testConfig({ WORKER_DOMAINS: 'comunication' });
    } catch (error) {
      problems = (error as ConfigValidationError).problems;
    }
    expect(problems.join(' ')).toMatch(/unknown domain/);
  });
});

describe('ER-041a: a job belongs to exactly one domain', () => {
  it('the same job name in two domains fails registration', () => {
    expect(() =>
      buildRegistry({
        system: { 'shared.name': () => Promise.resolve() },
        documents: { 'shared.name': () => Promise.resolve() },
      }),
    ).toThrow(JobRegistrationError);
  });
});

describe('ER-043: handlers bind tenant context exactly like the API', () => {
  it('the handler runs with app.current_company_id already set', async () => {
    await handle.uow.withTenant(COMPANY, async (tx) => {
      await queue.enqueue(tx, 'system', 'tenant.probe', { companyId: COMPANY });
    });

    expect(await boundTenant.promise).toBe(COMPANY);
  }, 60_000);
});

describe('ER-044: a permanently failing job becomes visible', () => {
  it('exhausts its retries and lands in the domain dead-letter queue', async () => {
    await handle.uow.withTenant(COMPANY, async (tx) => {
      await queue.enqueue(tx, 'documents', 'always.fails', { companyId: COMPANY });
    });

    await failures.promise;

    /* The point of ER-044 is not that it stops retrying — it is that stopping
       leaves something behind. Poll rather than sleep: the dead-letter move
       happens on pg-boss's maintenance pass, not on the failing delivery. */
    const dead = deadLetterQueue('documents');
    let size = 0;
    for (let attempt = 0; attempt < 60 && size === 0; attempt += 1) {
      size = await boss.getQueueSize(dead);
      if (size === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect(size).toBe(1);
    expect(dead).not.toBe('documents');
  }, 180_000);
});
