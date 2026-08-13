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
 *   $env:PGUSER = 'postgres'                       # PowerShell
 *   $env:PGPASSWORD = '<your postgres password>'
 *   pnpm db:setup
 *
 * Standard libpq variables are honoured: PGHOST, PGPORT, PGUSER, PGPASSWORD.
 * PGUSER is not optional on Windows — `pg` defaults it to the Windows account
 * name, not to `postgres`, so leaving it unset fails as an unknown role.
 * No password is ever read from, or written to, a file by this script.
 *
 * SQL construction note: PostgreSQL cannot bind identifiers or role passwords
 * as query parameters. Rather than interpolating them client-side — which
 * `AGENTS.md` §3.2 prohibits outright — every dynamic statement is built by
 * PostgreSQL itself through `format('%I' / '%L', $1, $2)` with the values sent
 * as bind parameters, so all quoting is done server-side by the database.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client } from 'pg';

import {
  ALL_ROLES,
  DEV_DATABASE,
  MIGRATOR_ROLE,
  PROVISIONED_ROLES,
  TEST_DATABASE,
  TEST_RUNNER_ROLE,
  roleAttributes,
  type RoleName,
} from './lib/roles.js';
import { generateSecret, renderEnvFile } from './lib/env-file.js';
import { SetupStepError, exec, execFormatted } from './lib/pg-exec.js';

const MINIMUM_SERVER_VERSION_NUM = 180_000; // PostgreSQL 18 (D-018, D-032)
const REPO_ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(REPO_ROOT, '.env');

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

/**
 * Creates the role if absent and applies its attributes. Never touches the
 * password, so this is safe to re-run against a live `.env` (`--roles-only`).
 */
async function ensureRole(client: Client, role: RoleName, rolesOnly = false): Promise<void> {
  const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const creating = existing.rowCount === 0;
  if (creating && rolesOnly) {
    throw new SetupStepError(
      `CREATE ROLE ${role}`,
      '--roles-only cannot create a role: it would have no password and no .env entry. ' +
        'Run without --roles-only for a first-time setup.',
    );
  }
  const attributes = roleAttributes(role);
  await execFormatted(
    client,
    `${creating ? 'CREATE' : 'ALTER'} ROLE ${role}`,
    `${creating ? 'CREATE' : 'ALTER'} ROLE %I ${attributes}`,
    [role],
  );
  process.stdout.write(`  role ${role.padEnd(18)} ${creating ? 'created' : 'updated'}\n`);
}

/**
 * Nobody is a member of the migrator (D-048a, amended).
 *
 * An earlier design had the runner create clones `OWNER findneo_migrator`,
 * which PostgreSQL only permits to a *member* of that role. The runner now
 * owns its clones outright, so the membership is unnecessary — and membership
 * in the migrator is precisely what must never exist, because `SET ROLE` would
 * reach `BYPASSRLS` from a role not supposed to have it.
 *
 * Revoked rather than merely not granted, so a cluster provisioned under the
 * earlier design is corrected by re-running. Revoking what was never granted
 * is a no-op.
 */
/**
 * The harness must disconnect other sessions before copying a database —
 * PostgreSQL refuses to copy a source that has connections. Terminating a
 * backend owned by another role requires `pg_signal_backend`; without it the
 * runner gets "permission denied to terminate process".
 *
 * `pg_signal_backend` cannot signal superuser backends, and confers nothing
 * else. It is not membership in any FindNeo role.
 */
async function grantSignalBackend(client: Client): Promise<void> {
  await execFormatted(
    client,
    `GRANT pg_signal_backend TO ${TEST_RUNNER_ROLE}`,
    'GRANT pg_signal_backend TO %I',
    [TEST_RUNNER_ROLE],
  );
  process.stdout.write(`  membership         ${TEST_RUNNER_ROLE} -> pg_signal_backend
`);
}

async function revokeMigratorMembership(client: Client): Promise<void> {
  await execFormatted(
    client,
    `REVOKE ${MIGRATOR_ROLE} FROM ${TEST_RUNNER_ROLE}`,
    'REVOKE %I FROM %I',
    [MIGRATOR_ROLE, TEST_RUNNER_ROLE],
  );
  process.stdout.write(`  membership         none in ${MIGRATOR_ROLE} (revoked if present)
`);
}

async function setRolePassword(client: Client, role: RoleName, password: string): Promise<void> {
  await execFormatted(client, `set password for ${role}`, 'ALTER ROLE %I PASSWORD %L', [
    role,
    password,
  ]);
}

async function ensureDatabase(client: Client, database: string, owner: RoleName): Promise<void> {
  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (existing.rowCount === 0) {
    await execFormatted(client, `CREATE DATABASE ${database}`, 'CREATE DATABASE %I OWNER %I', [
      database,
      owner,
    ]);
  } else {
    await execFormatted(
      client,
      `ALTER DATABASE ${database} OWNER`,
      'ALTER DATABASE %I OWNER TO %I',
      [database, owner],
    );
  }
  process.stdout.write(
    `  database ${database.padEnd(14)} ${existing.rowCount === 0 ? 'created' : 'exists'}\n`,
  );
}

/** Every role may reach the database and see the schema; nothing more. */
async function grantConnectAndUsage(client: Client, database: string): Promise<void> {
  for (const role of ALL_ROLES) {
    await execFormatted(
      client,
      `GRANT CONNECT ON ${database} TO ${role}`,
      'GRANT CONNECT ON DATABASE %I TO %I',
      [database, role],
    );
    await execFormatted(
      client,
      `GRANT USAGE ON SCHEMA public TO ${role} (${database})`,
      'GRANT USAGE ON SCHEMA public TO %I',
      [role],
    );
  }
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
    await exec(
      client,
      `CREATE EXTENSION citext (${database})`,
      'CREATE EXTENSION IF NOT EXISTS citext',
    );
    await exec(
      client,
      `REVOKE CREATE ON SCHEMA public (${database})`,
      'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
    );
    await execFormatted(
      client,
      `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`,
      'REVOKE ALL ON DATABASE %I FROM PUBLIC',
      [database],
    );
    await grantConnectAndUsage(client, database);
    await execFormatted(
      client,
      `GRANT CREATE ON SCHEMA public TO ${MIGRATOR_ROLE} (${database})`,
      'GRANT CREATE ON SCHEMA public TO %I',
      [MIGRATOR_ROLE],
    );
  } finally {
    await client.end();
  }
}

/** Roles, their attributes and memberships, and the two databases. */
async function provisionCluster(
  passwords: ReadonlyMap<RoleName, string>,
  rolesOnly: boolean,
): Promise<void> {
  const admin = await connect(process.env['PGDATABASE'] ?? 'postgres');
  try {
    await assertServerVersion(admin);
    process.stdout.write('PostgreSQL 18 confirmed.\n\n');
    for (const role of PROVISIONED_ROLES) {
      await ensureRole(admin, role, rolesOnly);
      if (!rolesOnly) await setRolePassword(admin, role, passwords.get(role) ?? '');
    }
    await revokeMigratorMembership(admin);
    await grantSignalBackend(admin);
    /* findneo_test is owned by the runner because PostgreSQL requires
       ownership of a database to copy it as a TEMPLATE (D-048a). findneo_dev
       keeps production's shape. Table ownership inside both stays with the
       migrator, and that is what FORCE ROW LEVEL SECURITY keys on. */
    await ensureDatabase(admin, DEV_DATABASE, MIGRATOR_ROLE);
    await ensureDatabase(admin, TEST_DATABASE, TEST_RUNNER_ROLE);
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  /* Re-applies role attributes and grants without rotating passwords or
     rewriting .env — for when a spec change alters what a role must hold, as
     D-047(b) did by requiring BYPASSRLS on the migrator. */
  const rolesOnly = process.argv.includes('--roles-only');

  // Checked before touching the database, so a refused run changes nothing.
  if (existsSync(ENV_PATH) && !force && !rolesOnly) {
    process.stderr.write(
      '.env already exists. Re-running would rotate the role passwords and\n' +
        'invalidate it. Pass --force to overwrite, after saving anything you\n' +
        'have customised, or --roles-only to re-apply role attributes and\n' +
        'grants while leaving .env and the passwords untouched.\n',
    );
    process.exitCode = 1;
    return;
  }

  const passwords = new Map<RoleName, string>(
    PROVISIONED_ROLES.map((role): [RoleName, string] => [role, generateSecret(24)]),
  );

  await provisionCluster(passwords, rolesOnly);

  for (const database of [DEV_DATABASE, TEST_DATABASE]) await prepareDatabase(database);

  if (rolesOnly) {
    process.stdout.write('\nRole attributes and grants re-applied. .env untouched.\n');
    return;
  }

  writeFileSync(ENV_PATH, renderEnvFile(passwords), { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(
    '\n.env written (mode 600, gitignored). Generated locally and not printed:\n' +
      '  four role passwords, an Ed25519 JWT keypair, a cookie secret.\n\n' +
      'Verify with: pnpm config:check\n',
  );
}

/**
 * `pg` does not read `.pgpass` and does not default `PGUSER` to `postgres` —
 * on Windows it falls back to the Windows account name, so an unset PGUSER
 * produces an authentication failure naming a user nobody created.
 */
const CONNECTION_HELP =
  'Set BOTH variables for this shell, then re-run:\n' +
  "  $env:PGUSER = 'postgres'\n" +
  "  $env:PGPASSWORD = '<postgres superuser password>'\n" +
  '  pnpm db:setup\n\n' +
  `PGUSER currently resolves to "${process.env['PGUSER'] ?? '(unset — defaults to your Windows account name)'}".\n` +
  'Optional: PGHOST (default localhost), PGPORT (default 5432).\n';

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nSetup failed at: ${message}\n\n`);
  if (/password|authentication|role .* does not exist|SASL/i.test(message)) {
    process.stderr.write(CONNECTION_HELP);
  }
  process.exitCode = 1;
});
