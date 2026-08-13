/**
 * Applies pending migrations. Explicit release-step command, never automatic
 * on process boot (SEC-065, ER-032) — an on-premise customer must be able to
 * take a backup first and roll back.
 *
 * Connects as `findneo_migrator`, the table owner, which never serves traffic.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { assertTestDatabaseName } from '../src/platform/config/database-url.js';
import { installQueueSchema } from '../src/platform/queue/install.js';

const MIGRATIONS_FOLDER = 'drizzle';

async function main(): Promise<void> {
  /* `--test` targets findneo_test as the owner role (11 §2). The harness needs
     a path to migrate the test database that is separate from the development
     one; the template build calls the same migrator programmatically. */
  const targetTest = process.argv.includes('--test');
  const variable = targetTest ? 'DATABASE_URL_TEST_OWNER' : 'DATABASE_URL_MIGRATOR';
  const url = process.env[variable];
  if (url === undefined || url === '') {
    throw new Error(`${variable} is required. It is written to .env by \`pnpm db:setup\`.`);
  }
  if (targetTest) assertTestDatabaseName(url, variable);

  const pool = new Pool({ connectionString: url, max: 1, application_name: 'findneo-migrate' });
  try {
    const database = new URL(url).pathname.replace(/^\//, '');
    process.stdout.write(`Applying migrations to "${database}"...\n`);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    process.stdout.write('Migrations applied.\n');

    /* pg-boss creates its own schema, tables and per-queue partitions — DDL
       the serving role deliberately cannot do. So it is installed here, as
       the migrator, and the app is granted DML on it (05a §5). */
    process.stdout.write('Installing queue schema...\n');
    await installQueueSchema(url);
    process.stdout.write('Queue schema installed.\n');
  } finally {
    await pool.end();
  }
}

await main();
