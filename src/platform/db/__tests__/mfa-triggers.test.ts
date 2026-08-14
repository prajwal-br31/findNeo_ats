import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';

/**
 * BR-011 — the database refuses a Super Admin without MFA (11 §3).
 *
 * Raw SQL, deliberately. These are database rules, and a test that goes
 * through the service proves the service is well behaved — not that the rule
 * holds. The whole point of enforcing BR-011 in a trigger is that it survives
 * a background job, a migration script, or a second service written by
 * somebody who never read 08 §3, and none of those go through `AuthService`.
 *
 * Run as `findneo_migrator`, which owns the tables and holds BYPASSRLS. That
 * is the most privileged thing that ever touches this database, and it is the
 * right adversary: if the rule holds against the migrator, it holds against
 * everything the application can do.
 *
 * The gap this closes: until now, no test executed either rejection path. The
 * suite proved signup does not *attempt* the grant; nothing proved the
 * database would *refuse* it. A window where migration 014 had not been
 * applied produced exactly the forbidden row, and 313 passing tests said
 * nothing about it.
 */

let database: TestDatabase;
let client: Client;

beforeAll(async () => {
  database = await createTestDatabase();
  client = new Client({ connectionString: database.ownerUrl });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client.end();
  await database.drop();
});

/** A company and a user, in a transaction the caller rolls back. */
async function seedUser(
  mfaEnabled: boolean,
  slug: string,
): Promise<{ company: string; user: string }> {
  const company = await client.query<{ id: string }>(
    `INSERT INTO companies (name, slug, country_code) VALUES ('T', $1, 'GB') RETURNING id`,
    [slug],
  );
  const companyId = company.rows[0]?.id as string;

  const user = await client.query<{ id: string }>(
    `INSERT INTO users (company_id, email, full_name, mfa_enabled)
     VALUES ($1, $2, 'T', $3) RETURNING id`,
    [companyId, `${slug}@trigger.test`, mfaEnabled],
  );

  return { company: companyId, user: user.rows[0]?.id as string };
}

function grantSuperAdmin(companyId: string, userId: string): Promise<unknown> {
  return client.query(
    `INSERT INTO user_roles (company_id, user_id, role_id)
     SELECT $1, $2, id FROM roles WHERE key = 'super_admin' AND company_id IS NULL`,
    [companyId, userId],
  );
}

describe('trg_owner_requires_mfa: the grant is refused without MFA', () => {
  it('rejects granting super_admin to a user with mfa_enabled = false', async () => {
    await client.query('BEGIN');
    try {
      const { company, user } = await seedUser(false, 'trg-no-mfa');

      await expect(grantSuperAdmin(company, user)).rejects.toThrow(
        /super_admin requires mfa_enabled/,
      );
    } finally {
      await client.query('ROLLBACK');
    }
  }, 60_000);

  it('permits the same grant once MFA is enabled', async () => {
    /* The negative case alone would pass against a trigger that rejected
       everything. This is what proves it discriminates. */
    await client.query('BEGIN');
    try {
      const { company, user } = await seedUser(true, 'trg-with-mfa');
      await grantSuperAdmin(company, user);

      const held = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1`,
        [user],
      );
      expect(held.rows[0]?.n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  }, 60_000);
});

describe('trg_owner_requires_mfa: only super_admin is gated', () => {
  it('leaves other roles assignable without MFA', async () => {
    /* Only super_admin is gated. Requiring MFA for every role would push
       people onto shared accounts, which is worse than what it prevents. */
    await client.query('BEGIN');
    try {
      const { company, user } = await seedUser(false, 'trg-other-role');
      await client.query(
        `INSERT INTO user_roles (company_id, user_id, role_id)
         SELECT $1, $2, id FROM roles WHERE key = 'recruiter' AND company_id IS NULL`,
        [company, user],
      );

      const held = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1`,
        [user],
      );
      expect(held.rows[0]?.n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  }, 60_000);
});

describe('trg_super_admin_keeps_mfa: MFA cannot be turned off afterwards', () => {
  it('rejects mfa_enabled -> false while the user holds super_admin', async () => {
    /* The bypass the first trigger did not cover: grant legitimately with MFA
       on, then turn MFA off. It reaches the forbidden state by a supported
       route — `POST /v1/users/current/actions/disable-mfa`. */
    await client.query('BEGIN');
    try {
      const { company, user } = await seedUser(true, 'trg-disable');
      await grantSuperAdmin(company, user);

      await expect(
        client.query(`UPDATE users SET mfa_enabled = false WHERE id = $1`, [user]),
      ).rejects.toThrow(/super_admin cannot disable mfa/);
    } finally {
      await client.query('ROLLBACK');
    }
  }, 60_000);

  it('permits disabling MFA for a user who does not hold super_admin', async () => {
    await client.query('BEGIN');
    try {
      const { user } = await seedUser(true, 'trg-disable-ok');
      await client.query(`UPDATE users SET mfa_enabled = false WHERE id = $1`, [user]);

      const row = await client.query<{ mfa_enabled: boolean }>(
        `SELECT mfa_enabled FROM users WHERE id = $1`,
        [user],
      );
      expect(row.rows[0]?.mfa_enabled).toBe(false);
    } finally {
      await client.query('ROLLBACK');
    }
  }, 60_000);
});

describe('trg_super_admin_keeps_mfa: it guards only that one transition', () => {
  it('permits unrelated updates to a super_admin row', async () => {
    /* The trigger fires on `UPDATE OF mfa_enabled`, so an ordinary profile
       edit must not fail for a user who happens to be an owner. */
    await client.query('BEGIN');
    try {
      const { company, user } = await seedUser(true, 'trg-unrelated');
      await grantSuperAdmin(company, user);

      await client.query(`UPDATE users SET full_name = 'Renamed' WHERE id = $1`, [user]);

      const row = await client.query<{ full_name: string }>(
        `SELECT full_name FROM users WHERE id = $1`,
        [user],
      );
      expect(row.rows[0]?.full_name).toBe('Renamed');
    } finally {
      await client.query('ROLLBACK');
    }
  }, 60_000);

  it('permits re-enabling MFA', async () => {
    await client.query('BEGIN');
    try {
      const { company, user } = await seedUser(true, 'trg-reenable');
      await grantSuperAdmin(company, user);

      /* false -> true is not the guarded transition. */
      await client.query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [user]);

      const row = await client.query<{ mfa_enabled: boolean }>(
        `SELECT mfa_enabled FROM users WHERE id = $1`,
        [user],
      );
      expect(row.rows[0]?.mfa_enabled).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }
  }, 60_000);
});
