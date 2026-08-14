import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../../platform/clock/system-clock.js';
import {
  Argon2PasswordHasher,
  dummyPasswordHash,
} from '../../../platform/crypto/argon2-password-hasher.js';
import { JwtTokenIssuer } from '../../../platform/crypto/jwt-token-issuer.js';
import { SecretBox } from '../../../platform/crypto/secret-box.js';
import { beginTotpEnrolment, verifyTotp } from '../../../platform/crypto/totp.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../../../platform/db/unit-of-work.js';
import { FakeQueue } from '../../../testing/fakes/fake-queue.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';
import { AuthService } from '../application/auth.service.js';
import { IdentityRepository } from '../infrastructure/identity.repository.js';

/**
 * T-026 — refresh rotation and family revocation.
 *
 * Step 3 of 08 §3 is what these exist for: replaying a rotated token means the
 * token was stolen, so the whole family dies. The test that matters is not
 * "rotation works" but "the legitimate session is killed too" — that is the
 * deliberate, counter-intuitive part, and the one a refactor would quietly
 * soften into "just reject the replay".
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
let service: AuthService;

const PASSWORD = 'correct-horse-battery-staple';
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIB2jQ2CQhFTL7hHCoBmqUCFAr0uJ8CV7cCE1zM1nGBLd
-----END PRIVATE KEY-----`;

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 6, applicationName: 'refresh-it' });

  const clock = new SystemClock();
  const hasher = new Argon2PasswordHasher();
  const secretBox = new SecretBox(Buffer.alloc(32, 7).toString('base64'));

  service = new AuthService({
    uow: handle.uow,
    repository: new IdentityRepository(),
    hasher,
    tokens: new JwtTokenIssuer(TEST_PRIVATE_KEY, clock),
    queue: new FakeQueue(),
    clock,
    dummyHash: () => dummyPasswordHash(hasher),
    mfa: {
      begin: (label) => beginTotpEnrolment(label),
      verify: (secret, label, code) => verifyTotp(secret, label, code),
      encrypt: (plaintext) => secretBox.encrypt(plaintext),
      decrypt: (envelope) => secretBox.decrypt(envelope),
    },
  });
}, 240_000);

afterAll(async () => {
  await handle.close();
  await database.drop();
});

/** Signs up, verifies and logs in — the shortest path to a refresh token. */
async function loggedInUser(slug: string): Promise<{ refreshToken: string; userId: string }> {
  const signup = await service.signup({
    companyName: 'Refresh Co',
    slug,
    countryCode: 'GB',
    fullName: 'Refresh User',
    email: `owner@${slug}.test`,
    password: PASSWORD,
  });
  await service.verifyEmail(signup.companyId, signup.userId, signup.verificationToken);

  const login = await service.login(`owner@${slug}.test`, PASSWORD, {
    ipAddress: null,
    deviceInfo: null,
  });
  return { refreshToken: login.refreshToken, userId: signup.userId };
}

async function liveSessionCount(userId: string): Promise<number> {
  const client = new Client({ connectionString: database.ownerUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

describe('T-026: rotation', () => {
  it('issues a new access token and a new refresh token', async () => {
    const { refreshToken } = await loggedInUser('refresh-rotate');
    const refreshed = await service.refresh(refreshToken, { ipAddress: null, deviceInfo: null });

    expect(refreshed.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(refreshed.refreshToken).not.toBe(refreshToken);
  }, 120_000);

  it('leaves exactly one live session in the family', async () => {
    const { refreshToken, userId } = await loggedInUser('refresh-one-live');
    await service.refresh(refreshToken, { ipAddress: null, deviceInfo: null });

    /* Revoke-then-create in one transaction. Two live sessions would mean the
       old token still works; zero would mean the user is logged out by a
       successful refresh. */
    expect(await liveSessionCount(userId)).toBe(1);
  }, 120_000);

  it('the rotated token no longer authenticates', async () => {
    const { refreshToken } = await loggedInUser('refresh-old-dead');
    await service.refresh(refreshToken, { ipAddress: null, deviceInfo: null });

    await expect(
      service.refresh(refreshToken, { ipAddress: null, deviceInfo: null }),
    ).rejects.toMatchObject({ code: 'ERR_UNAUTHENTICATED' });
  }, 120_000);
});

describe('T-026: family revocation on reuse', () => {
  it('replaying a rotated token revokes every session in the family', async () => {
    const { refreshToken, userId } = await loggedInUser('refresh-family');

    const second = await service.refresh(refreshToken, { ipAddress: null, deviceInfo: null });
    expect(await liveSessionCount(userId)).toBe(1);

    /* The replay. This is the theft signal. */
    await expect(
      service.refresh(refreshToken, { ipAddress: null, deviceInfo: null }),
    ).rejects.toMatchObject({ code: 'ERR_UNAUTHENTICATED' });

    /* And the legitimate holder is logged out too — deliberately. Leaving
       their session alive means sharing the account with whoever replayed. */
    expect(await liveSessionCount(userId)).toBe(0);

    await expect(
      service.refresh(second.refreshToken, { ipAddress: null, deviceInfo: null }),
    ).rejects.toMatchObject({ code: 'ERR_UNAUTHENTICATED' });
  }, 180_000);

  it('an unknown token is rejected without revoking anything', async () => {
    const { refreshToken, userId } = await loggedInUser('refresh-unknown');

    await expect(
      service.refresh('not-a-real-token-at-all-abcdefghij', {
        ipAddress: null,
        deviceInfo: null,
      }),
    ).rejects.toMatchObject({ code: 'ERR_UNAUTHENTICATED' });

    /* A garbage token must not be a denial-of-service against a real session. */
    expect(await liveSessionCount(userId)).toBe(1);
    await service.refresh(refreshToken, { ipAddress: null, deviceInfo: null });
  }, 120_000);
});

describe('T-026: logout', () => {
  it('revokes the presented session only, never the family', async () => {
    const { refreshToken, userId } = await loggedInUser('refresh-logout');
    const second = await service.refresh(refreshToken, { ipAddress: null, deviceInfo: null });

    await service.logout(second.refreshToken);
    expect(await liveSessionCount(userId)).toBe(0);
  }, 120_000);

  it('is idempotent and silent for an unknown token', async () => {
    /* Logout must succeed for a client holding anything at all, including a
       token from a session that has already gone. */
    await expect(service.logout('unknown-token-value-1234567890')).resolves.toBeUndefined();
  }, 60_000);
});
