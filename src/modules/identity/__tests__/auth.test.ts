import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../application/auth.service.js';
import { SystemClock } from '../../../platform/clock/system-clock.js';
import {
  Argon2PasswordHasher,
  dummyPasswordHash,
} from '../../../platform/crypto/argon2-password-hasher.js';
import { JwtTokenIssuer } from '../../../platform/crypto/jwt-token-issuer.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../../../platform/db/unit-of-work.js';
import { FakeQueue } from '../../../testing/fakes/fake-queue.js';
import { seedTwoTenants, type TwoTenants } from '../../../testing/harness/seed-two-tenants.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';
import { IdentityRepository } from '../infrastructure/identity.repository.js';

/**
 * T-024 / T-025 — signup and login against a real database.
 *
 * The leak tests are the ones that gate this feature (ER-054). Everything else
 * here is a happy path or an error shape; the two `describe`s at the bottom are
 * what decide whether tenant isolation actually holds for these endpoints.
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
let service: AuthService;
let tenants: TwoTenants;

/** A key generated for tests only. EdDSA, matching the token issuer. */
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIB2jQ2CQhFTL7hHCoBmqUCFAr0uJ8CV7cCE1zM1nGBLd
-----END PRIVATE KEY-----`;

const PASSWORD = 'correct-horse-battery-staple';

async function ownerClient(): Promise<Client> {
  const client = new Client({ connectionString: database.ownerUrl });
  await client.connect();
  return client;
}

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 6, applicationName: 'auth-it' });
  tenants = await seedTwoTenants(database);

  const clock = new SystemClock();
  const hasher = new Argon2PasswordHasher();

  service = new AuthService({
    uow: handle.uow,
    repository: new IdentityRepository(),
    hasher,
    tokens: new JwtTokenIssuer(TEST_PRIVATE_KEY, clock),
    queue: new FakeQueue(),
    clock,
    dummyHash: () => dummyPasswordHash(hasher),
  });
}, 240_000);

afterAll(async () => {
  await handle.close();
  await database.drop();
});

async function signupFixture(
  slug: string,
  email: string,
): Promise<{
  companyId: string;
  userId: string;
  token: string;
}> {
  const result = await service.signup({
    companyName: `Company ${slug}`,
    slug,
    countryCode: 'GB',
    fullName: 'Test Owner',
    email,
    password: PASSWORD,
  });
  return { companyId: result.companyId, userId: result.userId, token: result.verificationToken };
}

describe('T-024: signup is one transaction', () => {
  it('creates the company, the owner, and the owner role together', async () => {
    const { companyId, userId } = await signupFixture('gamma-co', 'owner@gamma.test');

    const client = await ownerClient();
    try {
      const { rows } = await client.query<{ owner: string; status: string; roles: string }>(
        `SELECT c.owner_user_id AS owner, c.status,
                (SELECT count(*) FROM user_roles ur WHERE ur.company_id = c.id) AS roles
           FROM companies c WHERE c.id = $1`,
        [companyId],
      );

      /* The circular FK is closed inside the transaction, not by a deferrable
         constraint (06 §3) — so the owner is set the moment the row is
         visible, never a step later. */
      expect(rows[0]?.owner).toBe(userId);
      expect(rows[0]?.status).toBe('pending_verification');
      expect(Number(rows[0]?.roles)).toBe(1);
    } finally {
      await client.end();
    }
  }, 60_000);

  it('issues no session — verification comes first', async () => {
    const { userId } = await signupFixture('delta-co', 'owner@delta.test');

    const client = await ownerClient();
    try {
      const { rows } = await client.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [userId]);
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  }, 60_000);
});

describe('T-024: signup rolls back completely', () => {
  it('leaves no partial company when the transaction fails', async () => {
    /* A duplicate slug fails *after* the company insert has already happened
       in a prior transaction, so this exercises rollback of a real partial
       state rather than a pre-flight rejection. */
    await signupFixture('epsilon-co', 'owner@epsilon.test');
    await expect(signupFixture('epsilon-co', 'other@epsilon.test')).rejects.toThrow();

    const client = await ownerClient();
    try {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM companies WHERE slug = $1`,
        ['epsilon-co'],
      );
      expect((rows[0] as { n: number }).n).toBe(1);

      /* The second attempt inserted nothing, so no orphaned user survives the
         rollback. This is the assertion that would catch a signup split across
         two transactions. */
      const orphan = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE email = $1`,
        ['other@epsilon.test'],
      );
      expect(orphan.rows[0]?.n).toBe(0);
    } finally {
      await client.end();
    }
  }, 60_000);
});

describe('T-024: signup does not confirm which companies exist', () => {
  it('rejects a reserved slug and a taken slug identically', async () => {
    /* Both are ERR_VALIDATION_FAILED naming /slug with the same message. A
       distinguishable response would tell an unauthenticated caller which
       companies exist. */
    const reserved = await service
      .signup({
        companyName: 'X',
        slug: 'admin',
        countryCode: 'GB',
        fullName: 'X',
        email: 'x@x.test',
        password: PASSWORD,
      })
      .catch((error: unknown) => error);

    await signupFixture('zeta-co', 'owner@zeta.test');
    const taken = await service
      .signup({
        companyName: 'X',
        slug: 'zeta-co',
        countryCode: 'GB',
        fullName: 'X',
        email: 'x2@x.test',
        password: PASSWORD,
      })
      .catch((error: unknown) => error);

    const shape = (error: unknown): unknown => JSON.parse(JSON.stringify(error));
    expect(shape(reserved)).toEqual(shape(taken));
  }, 60_000);
});

describe('T-025: login', () => {
  it('rejects an unverified account, then succeeds once verified', async () => {
    const { companyId, userId, token } = await signupFixture('eta-co', 'owner@eta.test');

    /* Unverified is one of the five situations that must be indistinguishable
       from a wrong password (08 §6). */
    await expect(
      service.login('owner@eta.test', PASSWORD, { ipAddress: null, deviceInfo: null }),
    ).rejects.toMatchObject({ code: 'ERR_UNAUTHENTICATED' });

    await service.verifyEmail(companyId as never, userId as never, token);

    const result = await service.login('owner@eta.test', PASSWORD, {
      ipAddress: null,
      deviceInfo: null,
    });
    expect(result.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(result.user.companyId).toBe(companyId);
  }, 60_000);

  it('answers identically for a wrong password and a nonexistent account', async () => {
    const missing = await service
      .login('nobody@nowhere.test', PASSWORD, { ipAddress: null, deviceInfo: null })
      .catch((error: unknown) => error);
    const wrong = await service
      .login('owner@eta.test', 'wrong-password-entirely', { ipAddress: null, deviceInfo: null })
      .catch((error: unknown) => error);

    expect(JSON.parse(JSON.stringify(missing))).toEqual(JSON.parse(JSON.stringify(wrong)));
  }, 60_000);
});

describe('SEC-015: uniform timing', () => {
  it('runs the hash even when no user exists, so timing does not leak', async () => {
    /* Not a wall-clock assertion — those are flaky on shared CI. This asserts
       the *mechanism*: a hasher that records its calls must see one on the
       nonexistent-account path, because skipping it is what creates the
       measurable difference. */
    let verifyCalls = 0;
    const hasher = new Argon2PasswordHasher();
    const counting = {
      hash: (plain: string) => hasher.hash(plain),
      verify: async (hash: string, plain: string) => {
        verifyCalls += 1;
        return hasher.verify(hash, plain);
      },
      needsRehash: (hash: string) => hasher.needsRehash(hash),
    };

    const clock = new SystemClock();
    const probe = new AuthService({
      uow: handle.uow,
      repository: new IdentityRepository(),
      hasher: counting,
      tokens: new JwtTokenIssuer(TEST_PRIVATE_KEY, clock),
      queue: new FakeQueue(),
      clock,
      dummyHash: () => dummyPasswordHash(hasher),
    });

    await probe
      .login('definitely-not-a-user@nowhere.test', PASSWORD, {
        ipAddress: null,
        deviceInfo: null,
      })
      .catch(() => undefined);

    expect(verifyCalls).toBe(1);
  }, 60_000);
});

describe('T-025: lockout', () => {
  it('locks the account after the threshold and keeps the failure generic', async () => {
    const { companyId, userId, token } = await signupFixture('theta-co', 'owner@theta.test');
    await service.verifyEmail(companyId as never, userId as never, token);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service
        .login('owner@theta.test', 'wrong', { ipAddress: null, deviceInfo: null })
        .catch(() => undefined);
    }

    /* The correct password now fails too — and fails the same way, because
       revealing the lock tells an attacker their guessing is working. */
    await expect(
      service.login('owner@theta.test', PASSWORD, { ipAddress: null, deviceInfo: null }),
    ).rejects.toMatchObject({ code: 'ERR_UNAUTHENTICATED' });

    const client = await ownerClient();
    try {
      const { rows } = await client.query<{ locked_until: Date | null }>(
        `SELECT locked_until FROM users WHERE id = $1`,
        [userId],
      );
      expect(rows[0]?.locked_until).not.toBeNull();
    } finally {
      await client.end();
    }
  }, 120_000);
});

describe('ER-054: cross-tenant leak — signup', () => {
  it('a new company cannot see, or be seen by, either seeded tenant', async () => {
    const { companyId } = await signupFixture('iota-co', 'owner@iota.test');

    /* Bound to the new tenant, both seeded companies must be invisible —
       including their users, departments and role assignments. */
    const visible = await handle.uow.withTenant(companyId as never, async (tx) => {
      const client = await import('../../../platform/db/tx-scope.js');
      const drizzle = client.unwrapTxScope(tx);
      const { sql } = await import('drizzle-orm');
      const result = await drizzle.execute<{ companies: string; users: string; depts: string }>(
        sql`select (select count(*) from companies) as companies,
                   (select count(*) from users)     as users,
                   (select count(*) from departments) as depts`,
      );
      return result.rows[0];
    });

    /* Its own company and its own owner, and nothing else. Two seeded tenants
       with a user and a department each exist in this database — if the counts
       included them, isolation would be broken and this test is the only thing
       that would say so. */
    expect(Number(visible?.companies)).toBe(1);
    expect(Number(visible?.users)).toBe(1);
    expect(Number(visible?.depts)).toBe(0);
  }, 60_000);

  it('the fixture really did seed a control tenant', async () => {
    /* Guards the assertion above from passing vacuously: if beta did not
       exist, "alpha is invisible" would be trivially true. */
    const client = await ownerClient();
    try {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM companies WHERE slug IN ($1, $2)`,
        [tenants.alpha.slug, tenants.beta.slug],
      );
      expect(Number(rows[0]?.n)).toBe(2);
    } finally {
      await client.end();
    }
  }, 60_000);
});

describe('ER-054: cross-tenant leak — login', () => {
  it('an email in one tenant cannot authenticate into another', async () => {
    const { companyId, userId, token } = await signupFixture('kappa-co', 'shared@example.test');
    await service.verifyEmail(companyId as never, userId as never, token);

    const result = await service.login('shared@example.test', PASSWORD, {
      ipAddress: null,
      deviceInfo: null,
    });

    /* The session must belong to the company the credentials belong to.
       A login that resolved to the wrong tenant would hand a valid token
       scoped to somebody else's data. */
    expect(result.user.companyId).toBe(companyId);
    expect(result.user.companyId).not.toBe(tenants.alpha.companyId);
    expect(result.user.companyId).not.toBe(tenants.beta.companyId);
  }, 60_000);

  it('the session row lands in the right tenant and nowhere else', async () => {
    const client = await ownerClient();
    try {
      const { rows } = await client.query<{ company_id: string }>(
        `SELECT s.company_id FROM sessions s
           JOIN users u ON u.id = s.user_id WHERE u.email = $1`,
        ['shared@example.test'],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.company_id).not.toBe(tenants.alpha.companyId);
      expect(rows[0]?.company_id).not.toBe(tenants.beta.companyId);
    } finally {
      await client.end();
    }
  }, 60_000);
});
