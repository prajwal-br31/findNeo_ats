import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

import { assertTestDatabaseName } from '../../platform/config/database-url.js';

/**
 * T-011 — template-database restore (11 §2, D-048a).
 *
 *   once per run   build `findneo_template_test`: clone the prepared base,
 *                  apply migrations as the owner
 *   per test       CREATE DATABASE … TEMPLATE …, owned by the creating role
 *   after test     DROP, by that same role
 *
 * Three roles, because no one role may hold all three capabilities:
 *   findneo_test_runner  CREATEDB — creates, owns and drops the databases
 *   findneo_migrator     migrates them; owns every TABLE inside
 *   findneo_app          what assertions run as; owns nothing, so FORCE bites
 *
 * The runner owns the databases outright (D-048a, amended). Assigning
 * ownership to another role would require membership in it, and membership in
 * `findneo_migrator` is the one thing that must never exist — `SET ROLE` would
 * reach `BYPASSRLS` from a role not supposed to have it.
 *
 * Database ownership and table ownership are separate. Table ownership inside
 * the clone stays with `findneo_migrator`, and that is what makes
 * `FORCE ROW LEVEL SECURITY` behave exactly as it does in production.
 *
 * Every database name this module creates or drops ends in `_test` and is
 * checked before the statement runs (D-046). The harness drops databases; a
 * name that slipped past the guard would take real work with it.
 */

const TEMPLATE_DATABASE = 'findneo_template_test';
const MIGRATIONS_FOLDER = 'drizzle';

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

function requireUrl(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new HarnessError(
      `${name} is required to run database tests, and is written to .env by \`pnpm db:setup\`. ` +
        'If .env predates D-048a it has no DATABASE_URL_TEST_RUNNER and no findneo_test_runner ' +
        'role exists: re-provision with `pnpm db:setup --force` (this rotates the role passwords).',
    );
  }
  return value;
}

/** Same credentials, different database. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Fixed-arity builders, one literal each — the same shape as
 * `scripts/setup-dev-db.ts`, and for the same two reasons: `format()` takes
 * `VARIADIC "any"` so the parameters need explicit casts, and assembling the
 * placeholder list by interpolation would itself be SQL built by
 * concatenation (ER-031).
 */
const FORMAT_QUERIES = [
  'SELECT format($1) AS sql',
  'SELECT format($1, $2::text) AS sql',
  'SELECT format($1, $2::text, $3::text) AS sql',
  'SELECT format($1, $2::text, $3::text, $4::text) AS sql',
] as const;

/**
 * `CREATE DATABASE` and `DROP DATABASE` take no bind parameters and cannot run
 * inside a transaction, so PostgreSQL quotes the identifiers itself via `%I`.
 * Callers must have passed the `_test` guard first.
 */
async function execDatabaseStatement(
  client: Client,
  template: string,
  params: readonly string[],
): Promise<void> {
  const builder = FORMAT_QUERIES[params.length];
  if (builder === undefined) {
    throw new HarnessError(`unsupported parameter count ${String(params.length)}`);
  }
  const built = await client.query<{ sql: string }>(builder, [template, ...params]);
  const sql = built.rows[0]?.sql;
  if (sql === undefined) throw new HarnessError('format() returned no statement');
  await client.query(sql);
}

/** Terminates other sessions; CREATE/DROP require the database to be idle. */
async function disconnectEveryoneFrom(client: Client, database: string): Promise<void> {
  await client.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [database],
  );
}

/** The runner owns what it creates, so it can drop it — no SET ROLE. */
async function dropDatabase(runnerUrl: string, database: string): Promise<void> {
  assertTestDatabaseName(withDatabase(runnerUrl, database), `drop ${database}`);
  await withClient(runnerUrl, async (client) => {
    await disconnectEveryoneFrom(client, database);
    await execDatabaseStatement(client, 'DROP DATABASE IF EXISTS %I', [database]);
  });
}

/**
 * Builds the template once per run.
 *
 * Cloned from the prepared base rather than from `template1`, because `citext`
 * and the schema grants were installed there by `pnpm db:setup` under a
 * superuser — privileges the migrator deliberately lacks. Migration 001's
 * extension block is then a no-op, which is exactly what its guard is for.
 */
export async function buildTemplateDatabase(): Promise<void> {
  const runnerUrl = requireUrl('DATABASE_URL_TEST_RUNNER');
  const ownerUrl = requireUrl('DATABASE_URL_TEST_OWNER');
  const baseDatabase = new URL(ownerUrl).pathname.replace(/^\//, '');

  assertTestDatabaseName(ownerUrl, 'DATABASE_URL_TEST_OWNER');
  assertTestDatabaseName(withDatabase(ownerUrl, TEMPLATE_DATABASE), 'template database');

  await dropDatabase(runnerUrl, TEMPLATE_DATABASE);

  await withClient(runnerUrl, async (client) => {
    await disconnectEveryoneFrom(client, baseDatabase);
    // No OWNER clause: the creating role owns it, which is the point.
    await execDatabaseStatement(client, 'CREATE DATABASE %I TEMPLATE %I', [
      TEMPLATE_DATABASE,
      baseDatabase,
    ]);
  });

  const templateOwnerUrl = withDatabase(ownerUrl, TEMPLATE_DATABASE);
  await withClient(templateOwnerUrl, async (client) => {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  });
}

export interface TestDatabase {
  readonly name: string;
  /** Connect as `findneo_app` — owns nothing, so RLS applies. */
  readonly appUrl: string;
  /** Connect as `findneo_migrator` — owner, for fixtures and assertions. */
  readonly ownerUrl: string;
  drop(): Promise<void>;
}

let cloneCounter = 0;

/**
 * One database per test, cloned from the template.
 *
 * The name always ends in `_test`, so the guard that protects the development
 * database also protects every clone this creates and drops.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const runnerUrl = requireUrl('DATABASE_URL_TEST_RUNNER');
  const ownerUrl = requireUrl('DATABASE_URL_TEST_OWNER');
  const appUrl = requireUrl('DATABASE_URL_TEST');

  cloneCounter += 1;
  const suffix = `${String(process.pid)}_${String(cloneCounter)}`;
  const name = `findneo_c${suffix}_test`;
  assertTestDatabaseName(withDatabase(ownerUrl, name), 'clone database');

  await withClient(runnerUrl, async (client) => {
    await disconnectEveryoneFrom(client, TEMPLATE_DATABASE);
    await execDatabaseStatement(client, 'CREATE DATABASE %I TEMPLATE %I', [
      name,
      TEMPLATE_DATABASE,
    ]);
  });

  /* No database-level ACL fixup. Table and schema privileges travel with the
     copy, and those are what every test asserts on; only the database's own
     ACL is not copied, and nothing depends on it. Leaving the default also
     keeps the migrator and app able to connect without another round trip. */

  return {
    name,
    appUrl: withDatabase(appUrl, name),
    ownerUrl: withDatabase(ownerUrl, name),
    drop: async (): Promise<void> => {
      await dropDatabase(runnerUrl, name);
    },
  };
}
