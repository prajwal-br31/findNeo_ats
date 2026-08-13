import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { assertTestDatabaseName } from '../../../config/database-url.js';
import { createDatabase, type DatabaseHandle } from '../../client.js';

/**
 * The RLS probe fixture.
 *
 * A throwaway tenant-scoped table carrying the canonical policy from
 * `06-data-model.md` §2, created and dropped per suite. It is **not** a
 * migration: Phase 0 ships no tables, and the property under test is the RLS
 * pattern itself rather than any particular table.
 *
 * Two connections, because the test is meaningless with one:
 *   - owner  (`findneo_migrator`) creates the table and seeds it, and is used
 *     to prove the rows actually exist
 *   - app    (`findneo_app`) is what the assertions run as — it owns nothing,
 *     so `FORCE ROW LEVEL SECURITY` genuinely applies to it
 *
 * Both URLs are checked against the `_test` suffix guard **before any DDL
 * runs**, so this can never create or drop anything in the dev database.
 *
 * Every statement below writes the table name as a literal rather than
 * interpolating a constant. ER-031 admits no exception for identifiers, and
 * Semgrep rule 1 flagged an earlier draft of this file that used `${…}` — the
 * fixture is not special, so it complies rather than being exempted.
 */

export const PROBE_TABLE = 'rls_probe';

export interface ProbeDatabase {
  /** Connected as `findneo_app` — subject to RLS. */
  readonly app: DatabaseHandle;
  /** Connected as the table owner — used only to set up and to prove seeding. */
  readonly ownerPool: Pool;
  readonly alpha: string;
  readonly beta: string;
  teardown(): Promise<void>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required to run database tests. Uncomment it in .env (written by \`pnpm db:setup\`).`,
    );
  }
  return value;
}

/** The canonical tenant policy of 06 §2, applied to the probe table. */
async function createProbeTable(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS rls_probe');
  await pool.query(
    'CREATE TABLE rls_probe (id uuid PRIMARY KEY DEFAULT uuidv7(), company_id uuid, label text NOT NULL)',
  );
  await pool.query('ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY');
  await pool.query('ALTER TABLE rls_probe FORCE ROW LEVEL SECURITY');
  await pool.query(`
    CREATE POLICY tenant_isolation ON rls_probe
      AS PERMISSIVE FOR ALL TO findneo_app
      USING      (company_id = current_setting('app.current_company_id', true)::uuid)
      WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid)
  `);
  await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON rls_probe TO findneo_app');
}

export async function setUpProbeDatabase(): Promise<ProbeDatabase> {
  const appUrl = requireEnv('DATABASE_URL_TEST');
  const ownerUrl = requireEnv('DATABASE_URL_TEST_OWNER');

  // Before any DDL. Refuses to touch a database that is not demonstrably a
  // test database, on either connection.
  assertTestDatabaseName(appUrl, 'DATABASE_URL_TEST');
  assertTestDatabaseName(ownerUrl, 'DATABASE_URL_TEST_OWNER');

  const ownerPool = new Pool({ connectionString: ownerUrl, max: 2 });
  await createProbeTable(ownerPool);

  const alpha = '01920000-0000-7000-8000-0000000000a1';
  const beta = '01920000-0000-7000-8000-0000000000b2';
  await ownerPool.query(
    "INSERT INTO rls_probe (company_id, label) VALUES ($1,'alpha row'),($2,'beta row'),(NULL,'platform row')",
    [alpha, beta],
  );

  /* Pool deliberately smaller than the concurrency the tests drive, so
     connections are reused. Reuse is what surfaces a context leak. */
  const app = createDatabase({ url: appUrl, poolMax: 2, applicationName: 'findneo-test-app' });

  return {
    app,
    ownerPool,
    alpha,
    beta,
    teardown: async (): Promise<void> => {
      await app.close();
      await ownerPool.query('DROP TABLE IF EXISTS rls_probe');
      await ownerPool.end();
    },
  };
}

/** Row count visible to `findneo_app` under whatever context is bound. */
export async function visibleRowCount(handle: DatabaseHandle): Promise<number> {
  const result = await handle.db.execute<{ count: string }>(
    sql`select count(*)::text as count from rls_probe`,
  );
  return Number.parseInt(result.rows[0]?.count ?? '-1', 10);
}
