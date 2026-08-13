import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QUEUE_DOMAINS } from '../../../shared/ports/queue.js';
import { unsafeCompanyId } from '../../../shared/types/ids.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../../db/unit-of-work.js';
import { installQueueSchema } from '../install.js';
import { PgBossQueue } from '../pg-boss-queue.js';
import { QUEUE_POLICIES, deadLetterQueue } from '../queue-policies.js';

/**
 * T-013 — the queue adapter against real pg-boss.
 *
 * The property worth the setup cost is transactional enqueue: a job must
 * commit with the state change that caused it and vanish when that rolls back
 * (ER-028). That is the entire reason pg-boss was chosen over Redis (D-016),
 * so it is tested against the real thing rather than a fake.
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
let boss: PgBoss;
let queue: PgBossQueue;
const COMPANY = unsafeCompanyId('01920000-0000-7000-8000-0000000000a1');

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 4, applicationName: 'queue-it' });

  /* Installed as the migrator, exactly as the migration step does: pg-boss
     needs DDL rights the serving role does not have (05a §5). */
  await installQueueSchema(database.ownerUrl);

  /* The adapter then runs as the application role, which is what proves the
     grants are sufficient — an owner connection would pass regardless. */
  boss = new PgBoss({ connectionString: database.appUrl, schema: 'pgboss', supervise: false });
  await boss.start();
  queue = new PgBossQueue(boss);
}, 180_000);

afterAll(async () => {
  await boss.stop({ graceful: false });
  await handle.close();
  await database.drop();
});

async function queueSize(domain: string): Promise<number> {
  return boss.getQueueSize(domain);
}

describe('D-039: six domains, each with its own policy', () => {
  it('every domain has a queue', async () => {
    for (const domain of QUEUE_DOMAINS) {
      expect(await boss.getQueue(domain)).not.toBeNull();
    }
  });

  it('every domain has a dead-letter queue that is not itself (ER-044)', async () => {
    for (const domain of QUEUE_DOMAINS) {
      const queueRecord = await boss.getQueue(domain);
      expect(queueRecord?.deadLetter).toBe(deadLetterQueue(domain));
      expect(queueRecord?.deadLetter).not.toBe(domain);
    }
  });

  it('the six policies are genuinely distinct, not copy-pasted', () => {
    /* The split only buys anything if the domains actually differ — identical
       policies would be six queues behaving as one pool. */
    const concurrencies = new Set(QUEUE_DOMAINS.map((d) => QUEUE_POLICIES[d].concurrency));
    expect(concurrencies.size).toBeGreaterThan(3);
    expect(QUEUE_POLICIES.communication.concurrency).toBeGreaterThan(QUEUE_POLICIES.ai.concurrency);
    expect(QUEUE_POLICIES.integrations.retries).toBeGreaterThan(QUEUE_POLICIES.system.retries);
  });

  it('every domain declares a tenant cap for D-040', () => {
    for (const domain of QUEUE_DOMAINS) {
      expect(QUEUE_POLICIES[domain].tenantCap).toBeGreaterThan(0);
    }
  });
});

describe('ER-028: a job commits with its transaction', () => {
  it('an enqueue inside a committed transaction is visible', async () => {
    const before = await queueSize('documents');

    await handle.uow.withTenant(COMPANY, async (tx) => {
      await queue.enqueue(tx, 'documents', 'resume.copy', { companyId: COMPANY });
    });

    expect(await queueSize('documents')).toBe(before + 1);
  });

  it('an enqueue inside a rolled-back transaction leaves nothing', async () => {
    const before = await queueSize('recruitment');

    await expect(
      handle.uow.withTenant(COMPANY, async (tx) => {
        await queue.enqueue(tx, 'recruitment', 'sla.check', { companyId: COMPANY });
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');

    /* This is the whole reason pg-boss lives in the same database (D-016). A
       Redis-backed queue cannot do this, and a job fired for a row that rolled
       back is worse than a job never sent. */
    expect(await queueSize('recruitment')).toBe(before);
  });

  it('enqueue refuses a scope whose transaction has ended', async () => {
    let escaped: Parameters<Parameters<typeof handle.uow.withTenant>[1]>[0] | undefined;
    await handle.uow.withTenant(COMPANY, (tx) => {
      escaped = tx;
      return Promise.resolve();
    });

    await expect(
      queue.enqueue(escaped as never, 'system', 'cleanup', { companyId: COMPANY }),
    ).rejects.toThrow();
  });
});

describe('ER-042a: the payload carries companyId', () => {
  it('the enqueued envelope preserves it for the handler to bind with', async () => {
    await handle.uow.withTenant(COMPANY, async (tx) => {
      await queue.enqueue(tx, 'system', 'retention.sweep', { companyId: COMPANY });
    });

    const [job] = await boss.fetch('system', { batchSize: 1 });
    expect(job).toBeDefined();
    const data = job?.data as { jobName: string; payload: { companyId: string } };
    expect(data.jobName).toBe('retention.sweep');
    expect(data.payload.companyId).toBe(COMPANY);
  });
});
