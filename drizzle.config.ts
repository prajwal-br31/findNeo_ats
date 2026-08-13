import { defineConfig } from 'drizzle-kit';

/**
 * Migration tooling configuration.
 *
 * This reads `process.env` directly, which is the one place outside
 * `src/platform/config` that does. It is deliberate: `drizzle-kit` is a
 * separate CLI process, and `DATABASE_URL_MIGRATOR` is intentionally **not**
 * part of the validated application config — the API and worker must never
 * hold table-owner credentials. It still fails fast on a missing value, which
 * is the property ER-046 is protecting.
 *
 * Migrations are applied by an explicit command in a release step, never
 * automatically on boot (SEC-065, ER-032).
 */

const url = process.env['DATABASE_URL_MIGRATOR'];
if (url === undefined || url === '') {
  throw new Error(
    'DATABASE_URL_MIGRATOR is required to run migrations. It is written to .env by `pnpm db:setup`.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/platform/db/schema',
  out: './drizzle',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
