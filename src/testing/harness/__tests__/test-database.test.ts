import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedTwoTenants } from '../seed-two-tenants.js';
import { buildTemplateDatabase, createTestDatabase, type TestDatabase } from '../test-database.js';

/**
 * T-011 — proves the template-restore machinery, against `rls_probe` rather
 * than against tenant tables, which do not exist until Phase 1 (D-048b).
 */

const clones: TestDatabase[] = [];

beforeAll(async () => {
  await buildTemplateDatabase();
}, 120_000);

afterAll(async () => {
  for (const clone of clones) await clone.drop();
});

async function queryOne<T extends Record<string, unknown>>(url: string, sql: string): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<T>(sql);
    const row = result.rows[0];
    if (row === undefined) throw new Error('no row');
    return row;
  } finally {
    await client.end();
  }
}

describe('template database', () => {
  it('carries the applied migrations', async () => {
    const clone = await createTestDatabase();
    clones.push(clone);

    const row = await queryOne<{ n: string }>(
      clone.ownerUrl,
      'SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations',
    );
    expect(Number.parseInt(row.n, 10)).toBeGreaterThan(0);
  });

  it('carries citext, which the migrator could not have installed itself', async () => {
    const clone = await createTestDatabase();
    clones.push(clone);

    const row = await queryOne<{ present: boolean }>(
      clone.ownerUrl,
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citext') AS present",
    );
    expect(row.present).toBe(true);
  });
});

describe('per-test clones', () => {
  it('are owned by the role that created them — no SET ROLE needed (D-048a)', async () => {
    const clone = await createTestDatabase();
    clones.push(clone);

    const row = await queryOne<{ owner: string }>(
      clone.ownerUrl,
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()',
    );
    expect(row.owner).toBe('findneo_test_runner');
  });

  it('contain tables still owned by findneo_migrator — what FORCE RLS keys on', async () => {
    const clone = await createTestDatabase();
    clones.push(clone);

    /* Database ownership and table ownership are separate. The runner owning
       the database changes nothing about RLS; table ownership is what does. */
    const row = await queryOne<{ owner: string }>(
      clone.ownerUrl,
      "SELECT tableowner AS owner FROM pg_tables WHERE tablename = '__drizzle_migrations'",
    );
    expect(row.owner).toBe('findneo_migrator');
  });

  it('are named so the _test guard protects them', async () => {
    const clone = await createTestDatabase();
    clones.push(clone);
    expect(clone.name.endsWith('_test')).toBe(true);
  });
});

describe('clone isolation', () => {
  it('a write in one clone is invisible in another', async () => {
    const first = await createTestDatabase();
    const second = await createTestDatabase();
    clones.push(first, second);

    const client = new Client({ connectionString: first.ownerUrl });
    await client.connect();
    try {
      await client.query('CREATE TABLE clone_marker (id int)');
    } finally {
      await client.end();
    }

    const row = await queryOne<{ present: boolean }>(
      second.ownerUrl,
      "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'clone_marker') AS present",
    );
    expect(row.present).toBe(false);
  });

  it('are dropped cleanly', async () => {
    const survivor = clones[0];
    expect(survivor).toBeDefined();

    const clone = await createTestDatabase();
    await clone.drop();

    const client = new Client({ connectionString: survivor?.ownerUrl });
    await client.connect();
    try {
      const result = await client.query<{ present: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present',
        [clone.name],
      );
      expect(result.rows[0]?.present).toBe(false);
    } finally {
      await client.end();
    }
  });
});

describe('seedTwoTenants (D-048b, T-020a)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    clones.push(database);
  }, 120_000);

  it('seeds two genuinely distinct tenants', async () => {
    const seeded = await seedTwoTenants(database);

    /* The fixture's whole job is to make a leak test meaningful, so what is
       asserted is that the control tenant actually exists and differs. */
    expect(seeded.alpha.companyId).not.toBe(seeded.beta.companyId);
    expect(seeded.alpha.ownerUserId).not.toBe(seeded.beta.ownerUserId);
    expect(seeded.alpha.departmentId).not.toBe(seeded.beta.departmentId);
    expect(seeded.alpha.slug).not.toBe(seeded.beta.slug);
  }, 60_000);

  it('proves migration 015 seeded through the BYPASSRLS path (D-047b)', async () => {
    /* Migration 015 runs as findneo_migrator against tables migration 013 put
       under FORCE ROW LEVEL SECURITY. Under FORCE the owner is subject to
       policies too, and no policy names the migrator — so without BYPASSRLS
       every insert in 015 is denied. This asserts the result of that path,
       which had never executed before this slice. */
    const client = new Client({ connectionString: database.ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ permissions: string; roles: string }>(
        `SELECT (SELECT count(*) FROM permissions) AS permissions,
                (SELECT count(*) FROM roles WHERE company_id IS NULL) AS roles`,
      );
      expect(Number(rows[0]?.permissions)).toBeGreaterThan(60);
      expect(Number(rows[0]?.roles)).toBe(8);
    } finally {
      await client.end();
    }
  }, 60_000);
});
