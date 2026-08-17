import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createUnitOfWork, type UnitOfWorkHandle } from '../../../platform/db/unit-of-work.js';
import { seedTwoTenants, type TwoTenants } from '../../../testing/harness/seed-two-tenants.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';

/**
 * T-071 — the concurrent application cap under contention (BR-057, BR-058).
 *
 * **This tests the trigger, not the service.** The service deliberately does
 * not pre-check the cap, so a test that went through it would prove nothing
 * about the race: it would exercise the same single-threaded path either way.
 * Two real connections, two real transactions, overlapping in time, is the
 * only shape that can distinguish a working `FOR UPDATE` from a missing one.
 *
 * The failure this exists to catch is silent. Without the row lock both
 * transactions read `count = 0`, both pass the check, and both insert — and
 * nothing anywhere reports an error. The candidate simply ends up with two
 * active applications against a cap of one.
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
let tenants: TwoTenants;

let jobAId: string;
let jobBId: string;
let candidateId: string;
let formVersionId: string;

async function ownerClient(): Promise<Client> {
  const client = new Client({ connectionString: database.ownerUrl });
  await client.connect();
  return client;
}

/**
 * Inserts an application on a raw connection, as the migrator.
 *
 * Bypassing RLS is deliberate: this test is about the trigger's locking, and
 * routing through the app role would add a second variable. The trigger fires
 * for every insert regardless of role, which is the property being relied on.
 */
async function insertApplication(client: Client, jobId: string): Promise<void> {
  await client.query(
    `INSERT INTO applications (
       company_id, job_id, candidate_id, source, form_template_version_id, snapshot_full_name
     ) VALUES ($1, $2, $3, 'internal_add', $4, 'Race Subject')`,
    [tenants.alpha.companyId, jobId, candidateId, formVersionId],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 6, applicationName: 'cap-it' });
  tenants = await seedTwoTenants(database);

  const client = await ownerClient();
  try {
    const { rows: versions } = await client.query<{ id: string }>(
      `SELECT v.id FROM form_template_versions v
         JOIN form_templates t ON t.id = v.template_id
        WHERE t.entity_type = 'application' AND v.published_at IS NOT NULL
        LIMIT 1`,
    );
    formVersionId = versions[0]?.id ?? '';

    const { rows: jobs } = await client.query<{ id: string }>(
      `INSERT INTO jobs (company_id, department_id, title, status, form_template_version_id, created_by)
       VALUES ($1, $2, 'Race Job A', 'open', $3, $4),
              ($1, $2, 'Race Job B', 'open', $3, $4)
       RETURNING id`,
      [
        tenants.alpha.companyId,
        tenants.alpha.departmentId,
        formVersionId,
        tenants.alpha.ownerUserId,
      ],
    );
    jobAId = jobs[0]?.id ?? '';
    jobBId = jobs[1]?.id ?? '';

    const { rows: people } = await client.query<{ id: string }>(
      `INSERT INTO candidates (company_id, full_name) VALUES ($1, 'Race Subject') RETURNING id`,
      [tenants.alpha.companyId],
    );
    candidateId = people[0]?.id ?? '';

    /* Explicit rather than relying on the platform default, so the test states
       the cap it is asserting against. */
    await client.query(
      `INSERT INTO settings (company_id, key, value) VALUES ($1, $2, '1'::jsonb)
       ON CONFLICT (company_id, key) WHERE company_id IS NOT NULL DO UPDATE SET value = '1'::jsonb`,
      [tenants.alpha.companyId, 'candidate.max_active_applications'],
    );
  } finally {
    await client.end();
  }
}, 300_000);

afterAll(async () => {
  await handle.close();
  await database.drop();
});

describe('T-061/T-071: the application cap holds under a real race (BR-058)', () => {
  it('lets exactly one of two simultaneous submissions through', async () => {
    const first = await ownerClient();
    const second = await ownerClient();

    try {
      await first.query('BEGIN');
      await second.query('BEGIN');

      /* The first insert takes the candidate row lock inside the trigger and
         holds it until commit. */
      await insertApplication(first, jobAId);

      /* Started but NOT awaited: this must block on the lock the first
         transaction holds. Awaiting it here would serialise the two by hand
         and test nothing — the overlap is the entire point. */
      const contended = insertApplication(second, jobBId);

      let secondFinished = false;
      void contended.then(
        () => {
          secondFinished = true;
        },
        () => {
          secondFinished = true;
        },
      );

      /* Give the second statement time to reach the lock and block on it. If
         `FOR UPDATE` were missing it would sail past the count check and
         finish here, which is what this observation catches. */
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondFinished).toBe(false);

      await first.query('COMMIT');

      /* Now the lock is released and the second transaction re-reads a count
         of 1 against a cap of 1, so the trigger raises. */
      await expect(contended).rejects.toMatchObject({ code: '23514' });
      await second.query('ROLLBACK');

      const check = await ownerClient();
      try {
        const { rows } = await check.query<{ count: string }>(
          `SELECT count(*) AS count FROM applications
            WHERE candidate_id = $1 AND status = 'active'`,
          [candidateId],
        );
        expect(Number(rows[0]?.count)).toBe(1);
      } finally {
        await check.end();
      }
    } finally {
      await first.end().catch(() => undefined);
      await second.end().catch(() => undefined);
    }
  }, 60_000);

  it('frees the slot when the first application closes (BR-059)', async () => {
    const client = await ownerClient();
    try {
      /* Rejecting the live application must let the candidate apply again —
         the cap counts active applications, and the partial unique index is
         scoped to active for the same reason. */
      await client.query(
        `UPDATE applications SET status = 'rejected', closed_at = now()
          WHERE candidate_id = $1 AND status = 'active'`,
        [candidateId],
      );

      await expect(insertApplication(client, jobBId)).resolves.toBeUndefined();

      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM applications WHERE candidate_id = $1`,
        [candidateId],
      );
      /* Two rows total, one active: the rejected one is retained, not replaced. */
      expect(Number(rows[0]?.count)).toBe(2);
    } finally {
      await client.end();
    }
  }, 60_000);
});
