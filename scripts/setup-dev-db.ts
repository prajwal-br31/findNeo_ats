/**
 * T-004 — local development database setup.
 *
 * Creates the dev and test databases, the four database roles with generated
 * passwords, and writes a `.env` this repository's config loader accepts.
 *
 * This replaces the Docker Compose stack for local development: PostgreSQL 18
 * runs natively. The on-premise Compose bundle is a release concern (T-163) and
 * is unaffected.
 *
 * Run it yourself — it needs a PostgreSQL superuser connection:
 *
 *   $env:PGPASSWORD = '<your postgres password>'   # PowerShell
 *   pnpm db:setup
 *
 * Standard libpq variables are honoured: PGHOST, PGPORT, PGUSER, PGPASSWORD.
 * No password is ever read from, or written to, a file by this script.
 *
 * SQL construction note: PostgreSQL cannot bind identifiers or role passwords
 * as query parameters. Rather than interpolating them client-side — which
 * `AGENTS.md` §3.2 prohibits outright — every dynamic statement is built by
 * PostgreSQL itself through `format('%I' / '%L', $1, $2)` with the values sent
 * as bind parameters, so all quoting is done server-side by the database.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client } from 'pg';

const MINIMUM_SERVER_VERSION_NUM = 180_000; // PostgreSQL 18 (D-018, D-032)
const REPO_ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(REPO_ROOT, '.env');

const DEV_DATABASE = 'findneo_dev';
const TEST_DATABASE = 'findneo_test';

/** Owns every table. Never serves traffic (06 §2). */
const MIGRATOR_ROLE = 'findneo_migrator';
/** The three traffic roles, named in 06 §2. None owns anything. */
const TRAFFIC_ROLES = ['findneo_app', 'findneo_public', 'findneo_platform'] as const;

type RoleName = typeof MIGRATOR_ROLE | (typeof TRAFFIC_ROLES)[number];

const ALL_ROLES: readonly RoleName[] = [MIGRATOR_ROLE, ...TRAFFIC_ROLES];

function generateSecret(bytes: number): string {
  // base64url: [A-Za-z0-9_-] only, so it needs no escaping inside a URL.
  return randomBytes(bytes).toString('base64url');
}

function generateJwtKeypairBase64(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    privateKey: Buffer.from(privateKey).toString('base64'),
    publicKey: Buffer.from(publicKey).toString('base64'),
  };
}

/** Has PostgreSQL build and run a statement, so it does the quoting. */
async function execFormatted(
  client: Client,
  template: string,
  params: readonly string[],
): Promise<void> {
  const placeholders = params.map((_, index) => `$${String(index + 2)}`).join(', ');
  const built = await client.query<{ sql: string }>(
    `SELECT format($1${placeholders === '' ? '' : `, ${placeholders}`}) AS sql`,
    [template, ...params],
  );
  const sql = built.rows[0]?.sql;
  if (sql === undefined) throw new Error('could not build statement');
  await client.query(sql);
}

async function connect(database: string): Promise<Client> {
  const client = new Client({ database });
  await client.connect();
  return client;
}

async function assertServerVersion(client: Client): Promise<void> {
  const result = await client.query<{ v: string }>(
    "SELECT current_setting('server_version_num') AS v",
  );
  const versionNum = Number.parseInt(result.rows[0]?.v ?? '0', 10);
  if (versionNum < MINIMUM_SERVER_VERSION_NUM) {
    throw new Error(
      `connected server is version_num ${String(versionNum)}; PostgreSQL 18+ is required ` +
        `(D-018). Check PGPORT — you may be connected to an older cluster.`,
    );
  }
}

async function ensureRole(client: Client, role: RoleName, password: string): Promise<void> {
  const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const template =
    existing.rowCount === 0
      ? 'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L'
      : 'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L';
  await execFormatted(client, template, [role, password]);
  process.stdout.write(
    `  role ${role.padEnd(18)} ${existing.rowCount === 0 ? 'created' : 'updated'}\n`,
  );
}

async function ensureDatabase(client: Client, database: string): Promise<void> {
  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (existing.rowCount === 0) {
    await execFormatted(client, 'CREATE DATABASE %I OWNER %I', [database, MIGRATOR_ROLE]);
  } else {
    await execFormatted(client, 'ALTER DATABASE %I OWNER TO %I', [database, MIGRATOR_ROLE]);
  }
  process.stdout.write(
    `  database ${database.padEnd(14)} ${existing.rowCount === 0 ? 'created' : 'exists'}\n`,
  );
}

/**
 * Per-database preparation. Deliberately minimal: the `citext` extension and
 * the role grants are also declared in shipped migration 001, which is what an
 * on-premise install runs. This function only makes a fresh local database
 * usable before any migration has been applied.
 */
async function prepareDatabase(database: string): Promise<void> {
  const client = await connect(database);
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');
    await execFormatted(client, 'REVOKE CREATE ON SCHEMA public FROM PUBLIC', []);
    await execFormatted(client, 'REVOKE ALL ON DATABASE %I FROM PUBLIC', [database]);
    for (const role of ALL_ROLES) {
      await execFormatted(client, 'GRANT CONNECT ON DATABASE %I TO %I', [database, role]);
      await execFormatted(client, 'GRANT USAGE ON SCHEMA public TO %I', [role]);
    }
    await execFormatted(client, 'GRANT CREATE ON SCHEMA public TO %I', [MIGRATOR_ROLE]);
  } finally {
    await client.end();
  }
}

function buildUrl(role: RoleName, password: string, database: string): string {
  const host = process.env['PGHOST'] ?? 'localhost';
  const port = process.env['PGPORT'] ?? '5432';
  return `postgres://${role}:${password}@${host}:${port}/${database}`;
}

function renderEnvFile(passwords: ReadonlyMap<RoleName, string>): string {
  const appPassword = passwords.get('findneo_app') ?? '';
  const migratorPassword = passwords.get(MIGRATOR_ROLE) ?? '';
  const keypair = generateJwtKeypairBase64();
  const storageRoot = resolve(REPO_ROOT, 'var/storage').replaceAll('\\', '/');

  return `# Generated by \`pnpm db:setup\`. Never commit this file (ER-046).
# Every value below is validated at startup by src/platform/config (SEC-060).

NODE_ENV=development
LOG_LEVEL=debug

API_HOST=127.0.0.1
API_PORT=3000

# /health/* and /metrics run on their own listener, loopback only (SEC-021).
OPS_HOST=127.0.0.1
OPS_PORT=9464

DATABASE_URL=${buildUrl('findneo_app', appPassword, DEV_DATABASE)}
DATABASE_POOL_MAX=10

# Tests use Testcontainers by default. Uncomment BOTH to run against the native
# ${TEST_DATABASE} database instead — the loader refuses any test database
# whose name does not end in "_test". The owner connection creates fixtures and
# proves seeded rows exist; the app connection is what RLS assertions run as.
# DATABASE_URL_TEST=${buildUrl('findneo_app', appPassword, TEST_DATABASE)}
# DATABASE_URL_TEST_OWNER=${buildUrl(MIGRATOR_ROLE, migratorPassword, TEST_DATABASE)}

# Migration tooling only. The application config loader deliberately does NOT
# read this — the API and worker must never hold table-owner credentials.
DATABASE_URL_MIGRATOR=${buildUrl(MIGRATOR_ROLE, migratorPassword, DEV_DATABASE)}

STORAGE_DRIVER=filesystem
STORAGE_FS_ROOT=${storageRoot}

MAIL_DRIVER=log

# Base64-encoded PEM. Generated locally, unique to this install (SEC-073).
JWT_PRIVATE_KEY=${keypair.privateKey}
JWT_PUBLIC_KEY=${keypair.publicKey}
COOKIE_SECRET=${generateSecret(32)}

SWAGGER_ENABLED=true
OTEL_ENABLED=false
`;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  // Checked before touching the database, so a refused run changes nothing.
  if (existsSync(ENV_PATH) && !force) {
    process.stderr.write(
      '.env already exists. Re-running would rotate the role passwords and\n' +
        'invalidate it. Pass --force to overwrite, after saving anything you\n' +
        'have customised.\n',
    );
    process.exitCode = 1;
    return;
  }

  const passwords = new Map<RoleName, string>(
    ALL_ROLES.map((role): [RoleName, string] => [role, generateSecret(24)]),
  );

  const admin = await connect(process.env['PGDATABASE'] ?? 'postgres');
  try {
    await assertServerVersion(admin);
    process.stdout.write('PostgreSQL 18 confirmed.\n\n');
    for (const [role, password] of passwords) await ensureRole(admin, role, password);
    for (const database of [DEV_DATABASE, TEST_DATABASE]) await ensureDatabase(admin, database);
  } finally {
    await admin.end();
  }

  for (const database of [DEV_DATABASE, TEST_DATABASE]) await prepareDatabase(database);

  writeFileSync(ENV_PATH, renderEnvFile(passwords), { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(
    '\n.env written (mode 600, gitignored). Generated locally and not printed:\n' +
      '  four role passwords, an Ed25519 JWT keypair, a cookie secret.\n\n' +
      'Verify with: pnpm config:check\n',
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nSetup failed: ${message}\n\n`);
  if (message.includes('password') || message.includes('authentication')) {
    process.stderr.write(
      'Set a superuser password for this shell first, then re-run:\n' +
        "  $env:PGPASSWORD = '<postgres password>'\n" +
        '  pnpm db:setup\n',
    );
  }
  process.exitCode = 1;
});
