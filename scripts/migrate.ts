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

const MIGRATIONS_FOLDER = 'drizzle';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL_MIGRATOR'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL_MIGRATOR is required. It is written to .env by `pnpm db:setup`.');
  }

  const pool = new Pool({ connectionString: url, max: 1, application_name: 'findneo-migrate' });
  try {
    const database = new URL(url).pathname.replace(/^\//, '');
    process.stdout.write(`Applying migrations to "${database}"...\n`);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    process.stdout.write('Migrations applied.\n');
  } finally {
    await pool.end();
  }
}

await main();
