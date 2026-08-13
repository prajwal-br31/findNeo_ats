import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config/config.js';
import { KNOWN_ENV_KEYS } from '../../config/config.schema.js';
import { assertTestDatabaseName } from '../../config/database-url.js';

/**
 * The compensating assertions D-047(b) requires.
 *
 * `findneo_migrator` holds `BYPASSRLS`. That is defensible only because it
 * grants nothing the owner could not grant itself, and only while the things
 * below remain true. Each is asserted against the live catalogue rather than
 * assumed, because "we would never do that" is not a control.
 *
 * These belong to the isolation suite that gates deployment (11 §4).
 */

let ownerPool: Pool;

beforeAll(() => {
  const ownerUrl = process.env['DATABASE_URL_TEST_OWNER'];
  if (ownerUrl === undefined || ownerUrl === '') {
    throw new Error('DATABASE_URL_TEST_OWNER is required. Uncomment it in .env.');
  }
  assertTestDatabaseName(ownerUrl, 'DATABASE_URL_TEST_OWNER');
  ownerPool = new Pool({ connectionString: ownerUrl, max: 1 });
});

afterAll(async () => {
  await ownerPool.end();
});

interface RoleRow {
  rolname: string;
  rolbypassrls: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
}

/** Roles that exist in a production cluster. The test runner does not. */
const PRODUCTION_ROLES = [
  'findneo_migrator',
  'findneo_app',
  'findneo_public',
  'findneo_platform',
] as const;

async function readRole(name: string): Promise<RoleRow | undefined> {
  const result = await ownerPool.query<RoleRow>(
    'SELECT rolname, rolbypassrls, rolsuper, rolcreatedb FROM pg_roles WHERE rolname = $1',
    [name],
  );
  return result.rows[0];
}

describe('SEC-003a: only the migrator may bypass RLS', () => {
  it('findneo_migrator holds BYPASSRLS, so migration 015 can seed under FORCE', async () => {
    const role = await readRole('findneo_migrator');
    expect(role?.rolbypassrls).toBe(true);
  });

  it.each(['findneo_app', 'findneo_public', 'findneo_platform'])(
    '%s does NOT hold BYPASSRLS',
    async (name) => {
      const role = await readRole(name);
      expect(role, `role ${name} is missing entirely`).toBeDefined();
      expect(role?.rolbypassrls).toBe(false);
    },
  );

  it.each(PRODUCTION_ROLES)('%s is not a superuser (06 §2)', async (name) => {
    const role = await readRole(name);
    expect(role?.rolsuper).toBe(false);
  });
});

describe('D-048a: only the test runner may create databases', () => {
  it.each(PRODUCTION_ROLES)('%s does NOT hold CREATEDB', async (name) => {
    /* Same shape as the BYPASSRLS check, but the reasoning does not transfer:
       an owner can grant itself BYPASSRLS by disabling FORCE, and cannot grant
       itself CREATEDB. So this one is a real capability boundary. */
    const role = await readRole(name);
    expect(role, `role ${name} is missing entirely`).toBeDefined();
    expect(role?.rolcreatedb).toBe(false);
  });

  it('findneo_test_runner holds CREATEDB and nothing else', async () => {
    const role = await readRole('findneo_test_runner');
    expect(role?.rolcreatedb).toBe(true);
    expect(role?.rolbypassrls).toBe(false);
    expect(role?.rolsuper).toBe(false);
  });
});

describe('role membership is not a back door', () => {
  async function isMemberOf(member: string, group: string): Promise<boolean> {
    const result = await ownerPool.query<{ member: boolean }>(
      'SELECT pg_has_role($1, $2, $3) AS member',
      [member, group, 'member'],
    );
    return result.rows[0]?.member ?? false;
  }

  it('findneo_test_runner is a member of findneo_migrator, as CREATE DATABASE … OWNER requires', async () => {
    expect(await isMemberOf('findneo_test_runner', 'findneo_migrator')).toBe(true);
  });

  it.each(['findneo_app', 'findneo_public', 'findneo_platform'])(
    '%s is NOT a member of findneo_migrator',
    async (name) => {
      /* Membership would hand a serving role BYPASSRLS by way of SET ROLE —
         the one capability the whole tenant model depends on withholding. */
      expect(await isMemberOf(name, 'findneo_migrator')).toBe(false);
    },
  );

  it.each(['findneo_app', 'findneo_public', 'findneo_platform'])(
    '%s is NOT a member of findneo_test_runner',
    async (name) => {
      expect(await isMemberOf(name, 'findneo_test_runner')).toBe(false);
    },
  );
});

describe('SEC-003a: migrator credentials cannot reach a serving process', () => {
  it('no application config field can hold the migrator connection string', () => {
    /* The whole control rests on this. If DATABASE_URL_MIGRATOR ever became
       readable by the config loader, the API and worker would be one
       misconfiguration away from running as a role that bypasses RLS. */
    expect(KNOWN_ENV_KEYS).not.toContain('DATABASE_URL_MIGRATOR');
  });

  it('no config field name suggests a migrator or owner connection', () => {
    const suspicious = KNOWN_ENV_KEYS.filter((key) => /MIGRAT|OWNER|SUPERUSER/i.test(key));
    expect(suspicious).toEqual([]);
  });

  it('the loader ignores DATABASE_URL_MIGRATOR even when it is present', () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL_MIGRATOR: 'postgres://findneo_migrator:secret@localhost:5432/findneo_test',
    });
    expect(config.database.url).not.toContain('findneo_migrator');
  });
});
