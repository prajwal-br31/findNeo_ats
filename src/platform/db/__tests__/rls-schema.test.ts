import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';

/**
 * T-023 — the schema-level RLS assertion (06 §8, 06 §10.9, 11 §3a).
 *
 * This is a control-integrity assertion, not a feature test. It does not ask
 * "does isolation work for users?" — `tenant-context.test.ts` asks that. It
 * asks whether the control is **switched on everywhere it should be**, and it
 * answers by enumerating the catalog rather than a list someone maintains by
 * hand.
 *
 * That distinction is the whole value. A hand-written list of tables passes
 * forever after someone adds table number fourteen and forgets migration 013.
 * Deriving the list from `information_schema` means the test starts failing
 * the moment the table exists — which is the same commit, not six months on.
 *
 * The two deliberate exemptions are named explicitly below. Naming them is
 * what stops the exemption list from quietly growing: adding to it is a
 * visible edit to a security test, in a diff someone reviews.
 */

let database: TestDatabase;
let client: Client;

/**
 * Tables with no `company_id` that are nonetheless in the tenant blast radius
 * if wrong. Both are intentional and both are argued, not assumed:
 *
 *  - `permissions` is a fixed global catalog. It has no tenant column because
 *    companies compose permissions into roles; they cannot invent them.
 *  - `role_permissions` is reachable only through `roles`, which is protected.
 *    A row here is meaningless without its role, and the role is tenant-scoped.
 */
const INTENTIONALLY_UNSCOPED = ['permissions', 'role_permissions'] as const;

beforeAll(async () => {
  database = await createTestDatabase();
  client = new Client({ connectionString: database.ownerUrl });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client.end();
  await database.drop();
});

async function rows<T>(sql: string): Promise<T[]> {
  const result = await client.query(sql);
  return result.rows as T[];
}

describe('every table carrying company_id has RLS enabled and forced', () => {
  it('finds the tenant tables by catalog, not by a maintained list', async () => {
    /* If this ever returns a suspiciously small number, the assertions below
       are passing vacuously — so the count is asserted before they run. */
    const scoped = await rows<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'company_id'
       ORDER BY table_name`);

    expect(scoped.length).toBeGreaterThanOrEqual(12);
  });

  it('has no tenant table with RLS off or unforced', async () => {
    /* Includes partitions: `relkind IN ('r','p')` covers both the partitioned
       parent and each partition, because a partition with RLS off is a way in
       that the parent's policy does not close. */
    const failures = await rows<{ table: string; enabled: boolean; forced: boolean }>(`
      SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND EXISTS (
           SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public'
              AND col.table_name = c.relname
              AND col.column_name = 'company_id'
         )
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
       ORDER BY c.relname`);

    expect(failures).toEqual([]);
  });

  it('covers `companies`, whose tenant key is `id` rather than company_id', async () => {
    /* The one table the catalog query above cannot find, precisely because it
       is the exception. Asserted separately rather than folded in, so the
       general rule stays a general rule. */
    const [companies] = await rows<{ enabled: boolean; forced: boolean }>(`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE relname = 'companies'`);

    expect(companies).toEqual({ enabled: true, forced: true });
  });
});

describe('the policies themselves are present and the exemptions are named', () => {
  it('gives every RLS-enabled tenant table at least one policy', async () => {
    /* ENABLE without a policy denies everything, which fails closed but is
       almost certainly a mistake — and one the assertion above cannot see. */
    const policyless = await rows<{ table: string }>(`
      SELECT c.relname AS table
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND c.relrowsecurity
         AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
       ORDER BY c.relname`);

    expect(policyless).toEqual([]);
  });

  it('exempts only the two tables named in this file', async () => {
    const noTenantColumn = await rows<{ table_name: string }>(`
      SELECT t.table_name FROM information_schema.tables t
       WHERE t.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND t.table_name <> 'companies'
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = t.table_name
              AND c.column_name = 'company_id'
         )
       ORDER BY t.table_name`);

    expect(noTenantColumn.map((row) => row.table_name).sort()).toEqual(
      [...INTENTIONALLY_UNSCOPED].sort(),
    );
  });
});

describe('the roles that serve traffic cannot bypass any of it', () => {
  it('findneo_app and findneo_public do not hold BYPASSRLS', async () => {
    /* The compensating assertion D-047b requires. Granting the migrator
       BYPASSRLS is only defensible while this stays true — asserted against
       pg_roles rather than assumed from the migration that created them. */
    const bypassers = await rows<{ rolname: string }>(`
      SELECT rolname FROM pg_roles
       WHERE rolbypassrls AND rolname IN ('findneo_app', 'findneo_public', 'findneo_platform')`);

    expect(bypassers).toEqual([]);
  });

  it('findneo_migrator does hold BYPASSRLS, because migration 015 needs it', async () => {
    /* The other direction. Without this the assertion above would still pass
       if someone revoked the migrator's grant, and migration 015 would fail
       on the next fresh install rather than here. */
    const [migrator] = await rows<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'findneo_migrator'`,
    );

    expect(migrator?.rolbypassrls).toBe(true);
  });

  it('audit_logs is append-only: no UPDATE or DELETE for findneo_app', async () => {
    /* SEC-036. The narrow default privileges in migration 001 are what make
       this the default rather than something to remember, but "the default
       held" is exactly the kind of thing worth asserting. */
    const granted = await rows<{ privilege_type: string }>(`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'findneo_app' AND table_name = 'audit_logs'
         AND privilege_type IN ('UPDATE', 'DELETE')`);

    expect(granted).toEqual([]);
  });
});
