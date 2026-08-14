import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../../platform/clock/system-clock.js';
import { Argon2PasswordHasher } from '../../../platform/crypto/argon2-password-hasher.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../../../platform/db/unit-of-work.js';
import { LogMailAdapter } from '../../../platform/mail/log-mail-adapter.js';
import { seedTwoTenants, type TwoTenants } from '../../../testing/harness/seed-two-tenants.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';
import { InvitationsService } from '../application/invitations.service.js';
import { IdentityRepository } from '../infrastructure/identity.repository.js';
import { InvitationsRepository } from '../infrastructure/invitations.repository.js';

/**
 * T-030 — invitations.
 *
 * The leak test is what gates the feature (ER-054). Invitations are the
 * natural place for a cross-tenant hole: the accept and preview routes are
 * unauthenticated, they resolve a row through a SECURITY DEFINER function that
 * deliberately sees every tenant, and the id-addressed routes take an id
 * straight from the URL.
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
let service: InvitationsService;
let tenants: TwoTenants;

const PASSWORD = 'correct-horse-battery-staple';

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 6, applicationName: 'invite-it' });
  tenants = await seedTwoTenants(database);

  service = new InvitationsService({
    uow: handle.uow,
    invitations: new InvitationsRepository(),
    identity: new IdentityRepository(),
    hasher: new Argon2PasswordHasher(),
    mail: new LogMailAdapter(),
    clock: new SystemClock(),
    appBaseUrl: 'http://localhost:3000',
  });
}, 240_000);

afterAll(async () => {
  await handle.close();
  await database.drop();
});

/** Reads the raw token back, which only the fixture may do. */
async function tokenFor(invitationId: string): Promise<string> {
  const client = new Client({ connectionString: database.ownerUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ token_hash: string }>(
      `SELECT token_hash FROM invitations WHERE id = $1`,
      [invitationId],
    );
    return rows[0]?.token_hash ?? '';
  } finally {
    await client.end();
  }
}

describe('T-030: create, list, revoke, resend', () => {
  it('creates an invitation and lists it', async () => {
    const created = await service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      email: 'invitee-a@alpha.test',
      roleKey: 'recruiter',
      departmentId: null,
    });

    const listed = await service.list(tenants.alpha.companyId);
    const found = listed.find((row) => row.id === created.id);
    expect(found?.email).toBe('invitee-a@alpha.test');
    expect(found?.roleKey).toBe('recruiter');
    expect(found?.status).toBe('pending');
  }, 60_000);

  it('refuses a second pending invitation to the same address', async () => {
    await expect(
      service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
        email: 'invitee-a@alpha.test',
        roleKey: 'recruiter',
        departmentId: null,
      }),
    ).rejects.toMatchObject({ code: 'ERR_DUPLICATE' });
  }, 60_000);
});

describe('T-030: resend and revoke', () => {
  it('resend replaces the token, so the old link stops working', async () => {
    const created = await service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      email: 'invitee-resend@alpha.test',
      roleKey: 'coordinator',
      departmentId: null,
    });
    const before = await tokenFor(created.id);

    await service.resend(tenants.alpha.companyId, created.id);
    const after = await tokenFor(created.id);

    /* A resend that reused the token would leave a forwarded old email just as
       valid as the new one. */
    expect(after).not.toBe(before);
  }, 60_000);

  it('revoke makes the invitation unusable', async () => {
    const created = await service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      email: 'invitee-revoke@alpha.test',
      roleKey: 'coordinator',
      departmentId: null,
    });

    await service.revoke(tenants.alpha.companyId, created.id);
    await expect(service.revoke(tenants.alpha.companyId, created.id)).rejects.toMatchObject({
      code: 'ERR_CONFLICT',
    });
  }, 60_000);
});

describe('T-030: accept', () => {
  it('creates an active user with the invited role, in one transaction', async () => {
    const created = await service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      email: 'accepts@alpha.test',
      roleKey: 'hiring_manager',
      departmentId: tenants.alpha.departmentId,
    });

    /* The service hashes the raw token; the fixture holds only the hash, so
       the accept path is driven with a token minted the same way. */
    const raw = await rawTokenByHash(created.id);
    const accepted = await service.accept({
      token: raw,
      fullName: 'New Joiner',
      password: PASSWORD,
    });

    expect(accepted.companyId).toBe(tenants.alpha.companyId);

    const client = new Client({ connectionString: database.ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{
        status: string;
        verified: Date | null;
        role_key: string;
        dept: string | null;
      }>(
        `SELECT u.status, u.email_verified_at AS verified, r.key AS role_key,
                (SELECT department_id FROM user_departments WHERE user_id = u.id) AS dept
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE u.id = $1`,
        [accepted.userId],
      );

      expect(rows[0]?.status).toBe('active');
      /* Receiving the token proved the address; no second verification round. */
      expect(rows[0]?.verified).not.toBeNull();
      expect(rows[0]?.role_key).toBe('hiring_manager');
      expect(rows[0]?.dept).toBe(tenants.alpha.departmentId);
    } finally {
      await client.end();
    }
  }, 120_000);
});

describe('T-030: a token is single-use', () => {
  it('a token cannot be redeemed twice', async () => {
    const created = await service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      email: 'twice@alpha.test',
      roleKey: 'coordinator',
      departmentId: null,
    });
    const raw = await rawTokenByHash(created.id);

    await service.accept({ token: raw, fullName: 'First', password: PASSWORD });
    await expect(
      service.accept({ token: raw, fullName: 'Second', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
  }, 120_000);

  it('a revoked invitation cannot be accepted', async () => {
    const created = await service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      email: 'revoked-accept@alpha.test',
      roleKey: 'coordinator',
      departmentId: null,
    });
    const raw = await rawTokenByHash(created.id);
    await service.revoke(tenants.alpha.companyId, created.id);

    await expect(
      service.accept({ token: raw, fullName: 'Nope', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
  }, 60_000);
});

describe('ER-054: cross-tenant leak — invitations', () => {
  it('beta cannot see alpha invitations in its list', async () => {
    await service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      email: 'leak-probe@alpha.test',
      roleKey: 'coordinator',
      departmentId: null,
    });

    const betaList = await service.list(tenants.beta.companyId);
    const emails = betaList.map((row) => row.email);
    expect(emails).not.toContain('leak-probe@alpha.test');
  }, 60_000);

  it('beta cannot revoke an alpha invitation, and gets 404 not 403', async () => {
    const alphaInvite = await service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      email: 'leak-revoke@alpha.test',
      roleKey: 'coordinator',
      departmentId: null,
    });

    /* 404, never 403 (SEC-026). A 403 confirms the id exists somewhere, which
       turns an id-addressed route into an existence oracle across tenants. */
    await expect(service.revoke(tenants.beta.companyId, alphaInvite.id)).rejects.toMatchObject({
      code: 'ERR_NOT_FOUND',
    });

    /* And it really is still pending — the 404 was a refusal, not a silent
       success that happened to report an error. */
    const stillPending = await service.list(tenants.alpha.companyId);
    expect(stillPending.find((row) => row.id === alphaInvite.id)?.status).toBe('pending');
  }, 60_000);

  it('beta cannot resend an alpha invitation', async () => {
    const alphaInvite = await service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      email: 'leak-resend@alpha.test',
      roleKey: 'coordinator',
      departmentId: null,
    });
    const before = await tokenFor(alphaInvite.id);

    await expect(service.resend(tenants.beta.companyId, alphaInvite.id)).rejects.toMatchObject({
      code: 'ERR_NOT_FOUND',
    });
    expect(await tokenFor(alphaInvite.id)).toBe(before);
  }, 60_000);
});

describe('ER-054: the accepted user lands in the invitation’s tenant', () => {
  it('accepting an alpha token creates the user in alpha, never in the caller’s tenant', async () => {
    const alphaInvite = await service.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      email: 'lands-in-alpha@alpha.test',
      roleKey: 'coordinator',
      departmentId: null,
    });
    const raw = await rawTokenByHash(alphaInvite.id);

    const accepted = await service.accept({
      token: raw,
      fullName: 'Alpha Joiner',
      password: PASSWORD,
    });

    /* The tenant comes from the invitation, never from the request. There is
       no company id on the accept route to forge. */
    expect(accepted.companyId).toBe(tenants.alpha.companyId);
    expect(accepted.companyId).not.toBe(tenants.beta.companyId);
  }, 120_000);

  it('the fixture really did seed a control tenant', async () => {
    /* Guards every assertion above from passing vacuously. */
    expect(tenants.beta.companyId).not.toBe(tenants.alpha.companyId);
    const betaList = await service.list(tenants.beta.companyId);
    expect(Array.isArray(betaList)).toBe(true);
  }, 60_000);
});

/**
 * The service stores only a hash, so tests drive accept with a token minted
 * here and written over the stored hash — the same thing the real flow does,
 * without needing the service to hand the raw token back.
 */
async function rawTokenByHash(invitationId: string): Promise<string> {
  const { createHash, randomBytes } = await import('node:crypto');
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');

  const client = new Client({ connectionString: database.ownerUrl });
  await client.connect();
  try {
    await client.query(`UPDATE invitations SET token_hash = $1 WHERE id = $2`, [
      hash,
      invitationId,
    ]);
    return raw;
  } finally {
    await client.end();
  }
}
