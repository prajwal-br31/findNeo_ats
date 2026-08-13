import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createUnitOfWork, type UnitOfWorkHandle } from '../../../platform/db/unit-of-work.js';
import { unsafeCompanyId } from '../../../shared/types/ids.js';
import { createTestDatabase, type TestDatabase } from '../../harness/test-database.js';
import { FakeQueue } from '../fake-queue.js';

/**
 * 11 §7: the `QueuePort` fake must enqueue inside the transaction like the real
 * one, so a rollback discards the job. Run against a real transaction, because
 * the property being tested *is* transaction behaviour.
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
const COMPANY = unsafeCompanyId('01920000-0000-7000-8000-0000000000a1');

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 2, applicationName: 'queue-test' });
}, 120_000);

afterAll(async () => {
  await handle.close();
  await database.drop();
});

describe('a job survives a commit', () => {
  it('is drainable once the transaction commits', async () => {
    const queue = new FakeQueue();

    await queue.withTransaction(handle.uow, COMPANY, async (tx) => {
      await queue.enqueue(tx, 'communication', 'notify.job_created', { companyId: COMPANY });
    });

    const drained = queue.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ domain: 'communication', jobName: 'notify.job_created' });
  });
});

describe('a job does NOT survive a rollback (ER-028, D-016)', () => {
  it('a rolled-back transaction discards the job', async () => {
    const queue = new FakeQueue();

    await expect(
      queue.withTransaction(handle.uow, COMPANY, async (tx) => {
        await queue.enqueue(tx, 'communication', 'notify.job_created', { companyId: COMPANY });
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');

    /* The eager fake — the obvious one — returns 1 here, and would let a
       service enqueue outside its transaction with every test still green. */
    expect(queue.drain()).toHaveLength(0);
  });

  it('a committed job alongside a rolled-back one: only the committed survives', async () => {
    const queue = new FakeQueue();

    await queue.withTransaction(handle.uow, COMPANY, async (tx) => {
      await queue.enqueue(tx, 'documents', 'kept', { companyId: COMPANY });
    });
    await expect(
      queue.withTransaction(handle.uow, COMPANY, async (tx) => {
        await queue.enqueue(tx, 'documents', 'discarded', { companyId: COMPANY });
        throw new Error('nope');
      }),
    ).rejects.toThrow();

    expect(queue.drain().map((job) => job.jobName)).toEqual(['kept']);
  });

  it('works for an untenanted transaction too — signup enqueues before a tenant exists', async () => {
    const queue = new FakeQueue();

    await queue.withTransaction(handle.uow, null, async (tx) => {
      await queue.enqueue(tx, 'communication', 'signup.verify', { companyId: COMPANY });
    });

    expect(queue.drain()).toHaveLength(1);
  });
});

describe('drain consumes; committed observes', () => {
  it('drain empties the buffer, committed does not', async () => {
    const queue = new FakeQueue();
    await queue.withTransaction(handle.uow, COMPANY, async (tx) => {
      await queue.enqueue(tx, 'system', 'cleanup', { companyId: COMPANY });
    });

    expect(queue.committed()).toHaveLength(1);
    expect(queue.committed()).toHaveLength(1);
    expect(queue.drain()).toHaveLength(1);
    expect(queue.drain()).toHaveLength(0);
  });
});
