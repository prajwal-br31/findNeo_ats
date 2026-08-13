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
}

async function readRole(name: string): Promise<RoleRow | undefined> {
  const result = await ownerPool.query<RoleRow>(
    'SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1',
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

  it.each(['findneo_migrator', 'findneo_app', 'findneo_public', 'findneo_platform'])(
    '%s is not a superuser (06 §2)',
    async (name) => {
      const role = await readRole(name);
      expect(role?.rolsuper).toBe(false);
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
