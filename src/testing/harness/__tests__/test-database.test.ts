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
  it('are owned by findneo_migrator, not by the role that created them', async () => {
    const clone = await createTestDatabase();
    clones.push(clone);

    const row = await queryOne<{ owner: string }>(
      clone.ownerUrl,
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()',
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

describe('seedTwoTenants (D-048b)', () => {
  it('throws rather than seeding nothing', () => {
    /* A fixture that returns empty tenants makes every leak test pass
       vacuously: alpha cannot read beta's data when beta has none. */
    expect(() => seedTwoTenants()).toThrow(/T-020a/);
  });
});
