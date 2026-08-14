import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LruCacheAdapter } from '../../../platform/cache/lru-cache-adapter.js';
import { SystemClock } from '../../../platform/clock/system-clock.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../../../platform/db/unit-of-work.js';
import { seedTwoTenants, type TwoTenants } from '../../../testing/harness/seed-two-tenants.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';
import { DepartmentsService } from '../application/departments.service.js';
import { FieldVisibilityService } from '../application/field-visibility.service.js';
import { PermissionsService } from '../application/permissions.service.js';
import { PlatformService } from '../application/platform.service.js';
import { RolesService } from '../application/roles.service.js';
import { DepartmentsRepository } from '../infrastructure/departments.repository.js';
import { FieldVisibilityRepository } from '../infrastructure/field-visibility.repository.js';
import { IdentityRepository } from '../infrastructure/identity.repository.js';
import { PlatformRepository } from '../infrastructure/platform.repository.js';
import { RolesRepository } from '../infrastructure/roles.repository.js';
import { unsafeUserId } from '../../../shared/types/ids.js';

/**
 * T-027 / T-029 / T-031 / T-032 / T-033.
 *
 * The two that gate their features are the escalation guard (BR-025) and the
 * cross-tenant set at the bottom (ER-054). Everything else is shape.
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
let tenants: TwoTenants;

let departments: DepartmentsService;
let roles: RolesService;
let permissions: PermissionsService;
let fieldVisibility: FieldVisibilityService;
let platform: PlatformService;

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 6, applicationName: 'access-it' });
  tenants = await seedTwoTenants(database);

  const cache = new LruCacheAdapter();
  permissions = new PermissionsService({
    uow: handle.uow,
    repository: new IdentityRepository(),
    cache,
  });
  departments = new DepartmentsService({
    uow: handle.uow,
    repository: new DepartmentsRepository(),
  });
  roles = new RolesService({ uow: handle.uow, repository: new RolesRepository(), permissions });
  fieldVisibility = new FieldVisibilityService({
    uow: handle.uow,
    repository: new FieldVisibilityRepository(),
    cache,
  });
  platform = new PlatformService({
    uow: handle.uow,
    repository: new PlatformRepository(),
    clock: new SystemClock(),
  });
}, 240_000);

afterAll(async () => {
  await handle.close();
  await database.drop();
});

describe('T-027: permission resolution and the tenant-keyed cache', () => {
  it('resolves the owner’s super_admin permissions', async () => {
    const resolved = await permissions.resolve(tenants.alpha.companyId, tenants.alpha.ownerUserId);
    expect(resolved.keys.has('users.invite')).toBe(true);
    expect(resolved.keys.has('roles.assign')).toBe(true);
  }, 60_000);

  it('does not serve one tenant’s permissions to another (ER-024)', async () => {
    /* Both owners hold super_admin, so equal *sets* prove nothing. What is
       asserted is that beta's owner resolves under beta — a key collision
       would return alpha's entry for beta's user id. */
    const alpha = await permissions.resolve(tenants.alpha.companyId, tenants.alpha.ownerUserId);
    const beta = await permissions.resolve(tenants.beta.companyId, tenants.beta.ownerUserId);
    expect(alpha.keys.size).toBeGreaterThan(0);
    expect(beta.keys.size).toBeGreaterThan(0);

    /* A user resolved under the *wrong* tenant must come back empty: the
       assignment rows are RLS-scoped, so beta's context sees none of alpha's. */
    const crossed = await permissions.resolve(tenants.beta.companyId, tenants.alpha.ownerUserId);
    expect(crossed.keys.size).toBe(0);
  }, 60_000);

  it('a revoked role takes effect on the next resolve, not after a TTL', async () => {
    /* rolesVersion is bumped by a trigger on user_roles, so the cache key
       changes and every stale entry becomes unreachable at once. */
    const before = await permissions.resolve(tenants.beta.companyId, tenants.beta.ownerUserId);
    expect(before.keys.size).toBeGreaterThan(0);

    const client = new Client({ connectionString: database.ownerUrl });
    await client.connect();
    try {
      await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [tenants.beta.ownerUserId]);
    } finally {
      await client.end();
    }

    const after = await permissions.resolve(tenants.beta.companyId, tenants.beta.ownerUserId);
    expect(after.keys.size).toBe(0);
  }, 60_000);
});

describe('T-029: masking resolves field visibility rules', () => {
  it('masks a field the caller lacks the permission for', async () => {
    const rules = await fieldVisibility.resolve(tenants.alpha.companyId);

    /* Migration 015 seeds jobs.salary_min -> jobs.salary.read. */
    expect(rules.requiredFor('jobs', 'salary_min')).toBe('jobs.salary.read');

    const withoutSalary = { keys: new Set<string>(['jobs.read']), departmentIds: [] };
    const masked = rules.apply('jobs', { title: 'Engineer', salary_min: 50_000 }, withoutSalary);

    /* Nulled with a marker (07 §8). The key survives, the value is null, and
       `_masked` names it — which is what lets a client distinguish
       "restricted" from "not set" without inferring. */
    expect(masked).toEqual({ title: 'Engineer', salary_min: null, _masked: ['salary_min'] });
  }, 60_000);

  it('leaves a field with no rule untouched', async () => {
    const rules = await fieldVisibility.resolve(tenants.alpha.companyId);
    const none = { keys: new Set<string>(), departmentIds: [] };
    /* No `_masked` key at all when nothing was withheld — an unrestricted
       response should not carry an empty array for clients to special-case. */
    expect(rules.apply('jobs', { title: 'Engineer' }, none)).toEqual({ title: 'Engineer' });
  }, 60_000);
});

describe('T-031: departments', () => {
  it('creates, lists and renames', async () => {
    const created = await departments.create(tenants.alpha.companyId, 'Design');
    const listed = await departments.list(tenants.alpha.companyId);
    expect(listed.some((row) => row.id === created.id)).toBe(true);

    await departments.rename(tenants.alpha.companyId, created.id, 'Product Design');
    const renamed = await departments.list(tenants.alpha.companyId);
    expect(renamed.find((row) => row.id === created.id)?.name).toBe('Product Design');
  }, 60_000);

  it('refuses a duplicate name', async () => {
    await departments.create(tenants.alpha.companyId, 'Duplicated');
    await expect(departments.create(tenants.alpha.companyId, 'Duplicated')).rejects.toMatchObject({
      code: 'ERR_DUPLICATE',
    });
  }, 60_000);
});

describe('T-031: department deletion is guarded', () => {
  it('refuses to delete a department with members', async () => {
    const created = await departments.create(tenants.alpha.companyId, 'Occupied');
    await departments.addMember(tenants.alpha.companyId, created.id, tenants.alpha.ownerUserId);

    /* The FK cascades, so a bare delete would silently detach every member —
       and membership is an access-scope input (04 §4). */
    await expect(departments.delete(tenants.alpha.companyId, created.id)).rejects.toMatchObject({
      code: 'ERR_CONFLICT',
    });

    await departments.removeMember(tenants.alpha.companyId, created.id, tenants.alpha.ownerUserId);
    await expect(departments.delete(tenants.alpha.companyId, created.id)).resolves.toBeUndefined();
  }, 60_000);
});

describe('T-032: the escalation guard (BR-025)', () => {
  it('refuses to create a role carrying a permission the actor lacks', async () => {
    /* Beta's owner lost every role in the T-027 test above, so they hold
       nothing — the cleanest possible actor for this. */
    await expect(
      roles.create(tenants.beta.companyId, tenants.beta.ownerUserId, {
        key: 'escalated',
        name: 'Escalated',
        scope: 'company',
        permissionKeys: ['roles.assign', 'users.deactivate'],
      }),
    ).rejects.toMatchObject({ code: 'ERR_FORBIDDEN' });
  }, 60_000);

  it('refuses to assign a role carrying a permission the actor lacks', async () => {
    const roleList = await roles.list(tenants.beta.companyId);
    const superAdmin = roleList.find((row) => row.key === 'super_admin');
    expect(superAdmin).toBeDefined();

    await expect(
      roles.assign(tenants.beta.companyId, tenants.beta.ownerUserId, tenants.beta.ownerUserId, {
        roleId: superAdmin?.id ?? '',
        departmentId: null,
      }),
    ).rejects.toMatchObject({ code: 'ERR_FORBIDDEN' });
  }, 60_000);
});

describe('T-032: roles within the actor’s own set', () => {
  it('permits a grant within the actor’s own set', async () => {
    /* Alpha's owner still holds super_admin, so granting a subset is fine. */
    const created = await roles.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      key: 'reader',
      name: 'Reader',
      scope: 'company',
      permissionKeys: ['users.read'],
    });
    expect(created.id).toBeTruthy();
  }, 60_000);

  it('refuses to edit a platform-default role', async () => {
    const roleList = await roles.list(tenants.alpha.companyId);
    const platformDefault = roleList.find((row) => row.companyId === null);
    expect(platformDefault).toBeDefined();

    await expect(
      roles.update(tenants.alpha.companyId, tenants.alpha.ownerUserId, platformDefault?.id ?? '', {
        name: 'Renamed',
      }),
    ).rejects.toMatchObject({ code: 'ERR_FORBIDDEN' });
  }, 60_000);
});

describe('T-033: impersonation is time-boxed, reasoned and audited', () => {
  it('refuses a grant without a real stated reason', async () => {
    await expect(
      platform.startImpersonation(
        unsafeUserId(tenants.alpha.ownerUserId),
        { companyId: tenants.alpha.companyId, reason: 'debug' },
        'trace-1',
      ),
    ).rejects.toMatchObject({ code: 'ERR_VALIDATION_FAILED' });
  }, 60_000);

  it('writes an audit row into the target tenant, visible to its Super Admin', async () => {
    const grant = await platform.startImpersonation(
      unsafeUserId(tenants.alpha.ownerUserId),
      { companyId: tenants.alpha.companyId, reason: 'Investigating ticket 4711' },
      'trace-2',
    );

    const client = new Client({ connectionString: database.ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ action: string; company_id: string }>(
        `SELECT action, company_id FROM audit_logs WHERE entity_id = $1`,
        [grant.grantId],
      );
      /* BR-006: the tenant learns about it, in their own audit log. */
      expect(rows[0]?.action).toBe('impersonation.started');
      expect(rows[0]?.company_id).toBe(tenants.alpha.companyId);
    } finally {
      await client.end();
    }
  }, 60_000);
});

describe('T-033: a grant is bounded and personal', () => {
  it('an ended grant no longer resolves', async () => {
    const grant = await platform.startImpersonation(
      unsafeUserId(tenants.alpha.ownerUserId),
      { companyId: tenants.alpha.companyId, reason: 'Investigating ticket 4712' },
      'trace-3',
    );

    expect(
      await platform.resolveGrant(unsafeUserId(tenants.alpha.ownerUserId), grant.grantId),
    ).toBe(tenants.alpha.companyId);

    await platform.endImpersonation(
      unsafeUserId(tenants.alpha.ownerUserId),
      grant.grantId,
      'trace-4',
    );

    expect(
      await platform.resolveGrant(unsafeUserId(tenants.alpha.ownerUserId), grant.grantId),
    ).toBeUndefined();
  }, 60_000);

  it('a grant does not resolve for a different staff member', async () => {
    const grant = await platform.startImpersonation(
      unsafeUserId(tenants.alpha.ownerUserId),
      { companyId: tenants.alpha.companyId, reason: 'Investigating ticket 4713' },
      'trace-5',
    );

    /* Holding a grant id is not holding the grant. */
    expect(
      await platform.resolveGrant(unsafeUserId(tenants.beta.ownerUserId), grant.grantId),
    ).toBeUndefined();
  }, 60_000);
});

describe('ER-054: cross-tenant leak — departments and roles', () => {
  it('beta cannot see or rename an alpha department', async () => {
    const alphaDept = await departments.create(tenants.alpha.companyId, 'Alpha Only');

    const betaList = await departments.list(tenants.beta.companyId);
    expect(betaList.some((row) => row.id === alphaDept.id)).toBe(false);

    await expect(
      departments.rename(tenants.beta.companyId, alphaDept.id, 'Hijacked'),
    ).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
  }, 60_000);

  it('beta cannot attach its own user to an alpha department (BR-008)', async () => {
    const alphaDept = await departments.create(tenants.alpha.companyId, 'Alpha Members');

    /* The composite FK is the control. The join row would live legitimately
       in beta's tenant, so RLS cannot catch it. */
    await expect(
      departments.addMember(tenants.beta.companyId, alphaDept.id, tenants.beta.ownerUserId),
    ).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
  }, 60_000);

  it('beta cannot see an alpha custom role', async () => {
    const alphaRole = await roles.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      key: 'alpha_only',
      name: 'Alpha Only',
      scope: 'company',
      permissionKeys: ['users.read'],
    });

    const betaRoles = await roles.list(tenants.beta.companyId);
    expect(betaRoles.some((row) => row.id === alphaRole.id)).toBe(false);

    /* Platform defaults are shared and must still be visible to both — the
       read policy on `roles` is the documented deviation (06 §4). */
    expect(betaRoles.some((row) => row.companyId === null)).toBe(true);
  }, 60_000);

  it('the fixture really did seed a control tenant', () => {
    expect(tenants.beta.companyId).not.toBe(tenants.alpha.companyId);
  });
});
