import { Client } from 'pg';

import {
  unsafeCompanyId,
  unsafeUserId,
  type CompanyId,
  type UserId,
} from '../../shared/types/ids.js';

import type { TestDatabase } from './test-database.js';

/**
 * The two-tenant fixture (11 §2, D-048b) — T-020a.
 *
 * Every suite gets two unrelated companies by default, because two tenants is
 * what makes the absence of a leak test obvious. `beta` exists to be the
 * control for every assertion made about `alpha`: without it, "alpha cannot
 * read beta's data" is a claim no test can distinguish from "there is no
 * data".
 *
 * **Seeded as the migrator, deliberately.** The migrator holds BYPASSRLS
 * (D-047b), so one connection can create both tenants without rebinding
 * context between them. Seeding through the app role would mean the fixture
 * exercised the same policies it exists to test against — and a fixture that
 * depends on the control under test cannot be trusted to set up its negative
 * case. Nothing here goes through application code for the same reason.
 */

export interface SeededTenant {
  readonly companyId: CompanyId;
  readonly slug: string;
  /** The founding Super Admin. Active and verified, ready to authenticate. */
  readonly ownerUserId: UserId;
  readonly ownerEmail: string;
  /** One department, so department-scoped assertions have something to scope to. */
  readonly departmentId: string;
}

export interface TwoTenants {
  /** The company under test. */
  readonly alpha: SeededTenant;
  /** An unrelated company. The control for every leak assertion. */
  readonly beta: SeededTenant;
}

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

/**
 * A password hash that is real argon2id output but corresponds to no password
 * anyone will guess. The fixture never logs in as these users through the
 * password path — tests that need a real login create their own user via the
 * signup service, so the hash they verify against is one the service wrote.
 */
const UNUSABLE_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2VlZHNlZWRzZWVk$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

interface TenantSpec {
  readonly slug: string;
  readonly name: string;
  readonly email: string;
  readonly fullName: string;
  readonly department: string;
}

const ALPHA: TenantSpec = {
  slug: 'alpha-co',
  name: 'Alpha Company',
  email: 'owner@alpha.test',
  fullName: 'Alpha Owner',
  department: 'Engineering',
};

const BETA: TenantSpec = {
  slug: 'beta-co',
  name: 'Beta Company',
  email: 'owner@beta.test',
  fullName: 'Beta Owner',
  department: 'Engineering',
};

async function seedTenant(client: Client, spec: TenantSpec): Promise<SeededTenant> {
  const company = await client.query<{ id: string }>(
    `INSERT INTO companies (name, slug, company_type, status, country_code)
     VALUES ($1, $2, 1, 'active', 'GB') RETURNING id`,
    [spec.name, spec.slug],
  );
  const companyId = company.rows[0]?.id;
  if (companyId === undefined) throw new SeedError(`company "${spec.slug}" did not insert`);

  const user = await client.query<{ id: string }>(
    `INSERT INTO users (company_id, email, password_hash, full_name, status,
                        email_verified_at, mfa_enabled)
     VALUES ($1, $2, $3, $4, 'active', now(), true) RETURNING id`,
    [companyId, spec.email, UNUSABLE_HASH, spec.fullName],
  );
  const ownerUserId = user.rows[0]?.id;
  if (ownerUserId === undefined) throw new SeedError(`owner for "${spec.slug}" did not insert`);

  /* The circular reference, closed the same way signup closes it: the company
     row exists first with a NULL owner, and the FK is satisfied by an UPDATE
     once the user exists (06 §3). */
  await client.query(`UPDATE companies SET owner_user_id = $1 WHERE id = $2`, [
    ownerUserId,
    companyId,
  ]);

  const departmentId = await seedDepartmentAndRole(client, spec, companyId, ownerUserId);

  return {
    companyId: unsafeCompanyId(companyId),
    slug: spec.slug,
    ownerUserId: unsafeUserId(ownerUserId),
    ownerEmail: spec.email,
    departmentId,
  };
}

/** Department, membership and the owner's super_admin grant. */
async function seedDepartmentAndRole(
  client: Client,
  spec: TenantSpec,
  companyId: string,
  ownerUserId: string,
): Promise<string> {
  const department = await client.query<{ id: string }>(
    `INSERT INTO departments (company_id, name) VALUES ($1, $2) RETURNING id`,
    [companyId, spec.department],
  );
  const departmentId = department.rows[0]?.id;
  if (departmentId === undefined)
    throw new SeedError(`department for "${spec.slug}" did not insert`);

  await client.query(
    `INSERT INTO user_departments (user_id, department_id, company_id, is_primary)
     VALUES ($1, $2, $3, true)`,
    [ownerUserId, departmentId, companyId],
  );

  /* Assign the platform-default super_admin. The role row is shared — every
     company reads the same platform default (company_id IS NULL) — while the
     assignment is tenant-scoped. */
  const assigned = await client.query(
    `INSERT INTO user_roles (company_id, user_id, role_id, granted_by)
     SELECT $1, $2, r.id, $2 FROM roles r WHERE r.key = 'super_admin' AND r.company_id IS NULL`,
    [companyId, ownerUserId],
  );
  if (assigned.rowCount !== 1) {
    throw new SeedError(
      `super_admin was not assigned in "${spec.slug}" — migration 015 seeds that role, so ` +
        'either it did not run or its BYPASSRLS path failed silently.',
    );
  }

  return departmentId;
}

/**
 * Seeds both tenants, or throws.
 *
 * It throws rather than returning empty tenants deliberately. A fixture that
 * silently seeds nothing makes every cross-tenant leak test pass vacuously:
 * alpha cannot read beta's data when beta has no data, so the suite goes green
 * while proving nothing at all. A red test saying "not seeded" is worth more
 * than a green one saying nothing — and ER-054 makes the leak test the thing
 * that decides whether a feature is done.
 *
 * Every insert above is checked for the same reason. `rowCount !== 1` on the
 * role assignment is the one most worth having: it is the only statement here
 * that can affect zero rows without erroring, and it does so exactly when
 * migration 015 has not seeded — which is the failure that would make an
 * authorization test meaningless rather than red.
 */
export async function seedTwoTenants(database: TestDatabase): Promise<TwoTenants> {
  const client = new Client({ connectionString: database.ownerUrl });
  await client.connect();

  try {
    await client.query('BEGIN');

    /* Asserted before seeding, so a missing catalog is reported as itself
       rather than as a confusing FK failure three statements later. */
    const catalog = await client.query<{ permissions: string; roles: string }>(
      `SELECT (SELECT count(*) FROM permissions) AS permissions,
              (SELECT count(*) FROM roles WHERE company_id IS NULL) AS roles`,
    );
    const permissionCount = Number(catalog.rows[0]?.permissions ?? 0);
    const roleCount = Number(catalog.rows[0]?.roles ?? 0);
    if (permissionCount === 0 || roleCount === 0) {
      throw new SeedError(
        `migration 015 did not seed: ${String(permissionCount)} permissions, ` +
          `${String(roleCount)} platform roles. It runs as findneo_migrator against tables ` +
          'under FORCE ROW LEVEL SECURITY and depends on BYPASSRLS (D-047b).',
      );
    }

    const alpha = await seedTenant(client, ALPHA);
    const beta = await seedTenant(client, BETA);

    if (alpha.companyId === beta.companyId) {
      throw new SeedError('alpha and beta are the same company — every leak test would be vacuous');
    }

    await client.query('COMMIT');
    return { alpha, beta };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
