import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { AppError } from '../../../shared/errors/app-error.js';
import type { ClockPort } from '../../../shared/ports/clock.js';
import type { PasswordHasherPort } from '../../../shared/ports/password-hasher.js';
import type { QueuePort } from '../../../shared/ports/queue.js';
import type { TokenIssuerPort } from '../../../shared/ports/token-issuer.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import {
  unsafeCompanyId,
  unsafeUserId,
  type CompanyId,
  type UserId,
} from '../../../shared/types/ids.js';
import { authenticationFailed, reservedSlug, slugUnavailable } from '../identity.errors.js';
import { RESERVED_SLUGS } from '../identity.schemas.js';
import type { AuthUserRow, IdentityRepository } from '../infrastructure/identity.repository.js';

/**
 * Authentication (08 §3, §5).
 *
 * Two flows, each one transaction. The transaction boundaries are the point:
 * a login that writes counters in one and the session in another can issue a
 * session for an account that was locked in between.
 */

/** Lockout policy (08 §3). */
export const FAILED_LOGIN_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;

/** Refresh lifetime (08 §3). */
export const REFRESH_TOKEN_TTL_DAYS = 30;

/** Email-verification token lifetime. */
const VERIFICATION_TTL_HOURS = 24;

export interface SignupInput {
  readonly companyName: string;
  readonly slug: string;
  readonly countryCode: string;
  readonly fullName: string;
  readonly email: string;
  readonly password: string;
}

export interface SignupResult {
  readonly companyId: CompanyId;
  readonly userId: UserId;
  /** Raw token. Returned only so dev tooling can surface it; never logged. */
  readonly verificationToken: string;
}

export interface RequestMeta {
  readonly ipAddress: string | null;
  readonly deviceInfo: string | null;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly expiresAt: Date;
  readonly refreshToken: string;
  readonly user: { id: UserId; email: string; fullName: string; companyId: CompanyId };
}

export interface AuthServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: IdentityRepository;
  readonly hasher: PasswordHasherPort;
  readonly tokens: TokenIssuerPort;
  readonly queue: QueuePort;
  readonly clock: ClockPort;
  /** A real argon2 hash matching no password. See `dummyPasswordHash`. */
  readonly dummyHash: () => Promise<string>;
}

/** Tokens are stored hashed and compared by hash (ER-047). */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function newToken(): string {
  /* 32 bytes of CSPRNG output. Not a UUID: a UUIDv4 carries 122 bits and is
     structured, and this is a bearer credential. */
  return randomBytes(32).toString('base64url');
}

/**
 * True for a specific unique-constraint violation.
 *
 * Walks the `cause` chain: Drizzle wraps the driver error in a
 * `DrizzleQueryError`, so `code` and `constraint` are one or two levels down.
 * Reading them off the top-level object silently never matches, which turns
 * the intended 422 into a 500 — and a 500 that looks exactly like a bug
 * because it is one.
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === constraint) return true;
    current = candidate.cause;
  }
  return false;
}

export class AuthService {
  readonly #deps: AuthServiceDeps;

  constructor(deps: AuthServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Signup — one transaction, all seeding included (08 §3, §5).
   *
   * The ordering is forced by two things that pull against each other: RLS
   * needs a bound tenant before any tenant-scoped insert, and the tenant does
   * not exist until the first insert. So the company row is created *before*
   * the context is bound, under `withoutTenant`, and everything after it runs
   * bound.
   *
   * No session is issued. Verification and MFA come first (08 §3 step 4);
   * returning a session here would make both advisory.
   */
  async signup(input: SignupInput): Promise<SignupResult> {
    if ((RESERVED_SLUGS as readonly string[]).includes(input.slug)) throw reservedSlug();

    const { uow, repository, hasher, queue, clock } = this.#deps;

    /* Hashed before the transaction opens. argon2id at OWASP parameters takes
       tens of milliseconds, and holding a database transaction — and its
       connection — open across it wastes the pool under signup load. */
    const passwordHash = await hasher.hash(input.password);

    const verificationToken = newToken();
    const verificationExpiry = new Date(
      clock.now().getTime() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000,
    );

    return uow.withNewTenant(async (tx: TxScope, bind) => {
      /* The id is minted before the row exists, and the context is bound
         before the INSERT rather than after it.
         
         08 §3 lists the insert first and `set_config` second. That order
         cannot work: `companies` is RLS-checked on its own primary key, so the
         WITH CHECK compares `id` against a GUC that would still be unset. The
         insert is rejected by the policy, not by anything the service can see.
         Binding first satisfies the same policy with the same guarantees —
         still one transaction, still no window in which anything is unscoped. */
      const companyId = unsafeCompanyId(await repository.nextCompanyId(tx));
      await bind(companyId);

      await this.#createCompany(tx, companyId, input);

      const user = await repository.insertUser(tx, {
        companyId,
        email: input.email,
        fullName: input.fullName,
        passwordHash,
      });
      const userId = unsafeUserId(user.id);

      /* Closes the circular FK: the company row already exists with a NULL
         owner, and this is the update that fills it (06 §3). */
      await repository.setOwner(tx, companyId, userId);

      await this.#grantOwnerRole(tx, companyId, userId);

      await repository.storeVerificationToken(
        tx,
        companyId,
        userId,
        hashToken(verificationToken),
        verificationExpiry,
      );

      /* In this transaction (ER-028, 08 §3 step h). Enqueueing after commit
         loses the email when the process dies between the two; enqueueing
         outside a transaction sends it for a signup that rolled back. */
      await queue.enqueue(tx, 'communication', 'notification.send', {
        companyId,
        // Ids only. No email address, no name (ER-042, ER-048).
        userId,
        template: 'email.verification',
      } as never);

      return { companyId, userId, verificationToken };
    });
  }

  /**
   * Login (08 §3).
   *
   * Every failure path returns the same body and a comparable duration. The
   * uniformity is the security property: an attacker who can distinguish
   * "wrong password" from "no such account" has a verified customer list.
   */
  async login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const { uow, repository, hasher, clock, dummyHash } = this.#deps;

    return uow.withoutTenant(async (tx: TxScope) => {
      const user = await repository.findAuthUserByEmail(tx, email);

      /* **Always run the verification**, against a dummy hash when there is no
         user (SEC-015). Returning early here would make a nonexistent account
         answer in a millisecond and a real one in fifty — a timing oracle that
         needs no statistics to read. */
      const hashToCheck = user?.passwordHash ?? (await dummyHash());
      const passwordMatches = await hasher.verify(hashToCheck, password);

      if (user === undefined) throw authenticationFailed();

      /* Locked accounts still ran the hash above, and still fail the same way.
         Revealing the lock tells an attacker their guessing is working, and
         tells anyone that the account exists. */
      const lockedUntil = user.lockedUntil;
      if (lockedUntil !== null && lockedUntil.getTime() > clock.now().getTime()) {
        throw authenticationFailed();
      }

      if (!passwordMatches) {
        await repository.recordFailedLogin(tx, user.id, FAILED_LOGIN_THRESHOLD, LOCKOUT_MINUTES);
        throw authenticationFailed();
      }

      assertUsable(user);

      if (user.mfaEnabled) {
        /* 08 §3 step 6 issues a short-lived challenge here and no session. The
           challenge token and POST /v1/auth/mfa/verify that consumes it are
           not in this slice, so this returns the catalog's MFA code rather
           than a challenge nothing can redeem. Failing closed: no session is
           issued either way. */
        throw new AppError('ERR_MFA_REQUIRED', {
          detail: 'Multi-factor authentication is required.',
        });
      }

      await repository.recordSuccessfulLogin(tx, user.id);

      return this.#openSession(tx, user, meta);
    });
  }

  /**
   * Inserts the company, translating a slug collision into the generic 422.
   *
   * The insert *is* the availability check. A prior SELECT would let two
   * simultaneous signups both see the slug free and both proceed; the unique
   * index is the only thing that actually decides. And the 422 says only
   * "unavailable" - confirming which slugs are taken maps the customer list of
   * a multi-tenant product from an unauthenticated endpoint (08 3).
   */
  async #createCompany(tx: TxScope, companyId: CompanyId, input: SignupInput): Promise<void> {
    try {
      await this.#deps.repository.insertCompany(tx, {
        id: companyId,
        name: input.companyName,
        slug: input.slug,
        countryCode: input.countryCode,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'uq_companies_slug')) throw slugUnavailable();
      throw error;
    }
  }

  async #grantOwnerRole(tx: TxScope, companyId: CompanyId, userId: UserId): Promise<void> {
    const assigned = await this.#deps.repository.assignPlatformRole(
      tx,
      companyId,
      userId,
      'super_admin',
    );
    if (assigned === 1) return;

    /* Migration 015 seeds super_admin. If it is missing, the alternative to
       failing here is a company whose owner holds no permissions - silently
       unusable, and indistinguishable from a permissions bug. */
    throw new AppError('ERR_INTERNAL', {
      detail: 'An unexpected error occurred.',
      cause: new Error('super_admin platform role is missing - migration 015 did not seed'),
    });
  }

  /** Creates the session row and mints the access token. */
  async #openSession(tx: TxScope, user: AuthUserRow, meta: RequestMeta): Promise<LoginResult> {
    const { repository, tokens, clock } = this.#deps;

    const companyId = unsafeCompanyId(user.companyId);
    const userId = unsafeUserId(user.id);
    const refreshToken = newToken();

    const session = await repository.insertSession(tx, {
      userId,
      companyId,
      /* A new family: this login is the root of its own rotation chain, and
         reuse detection revokes a family, so sharing one across logins would
         log a user out of every device when one token is replayed. */
      familyId: randomUUID(),
      refreshTokenHash: hashToken(refreshToken),
      expiresAt: new Date(clock.now().getTime() + REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      ipAddress: meta.ipAddress,
      deviceInfo: meta.deviceInfo,
    });

    const issued = await tokens.issueAccessToken({
      sub: userId,
      sid: session.id,
      cid: companyId,
      cap: 1,
    });

    return {
      accessToken: issued.token,
      expiresAt: issued.expiresAt,
      refreshToken,
      user: { id: userId, email: user.email, fullName: user.fullName, companyId },
    };
  }

  /**
   * Consumes an email-verification token.
   *
   * Not on the task list, and here because without it the token signup issues
   * is write-only and login can never succeed — 08 §7's manual flow is
   * signup → token → verify → login. Small enough to include; the slice is
   * not demonstrable without it.
   */
  async verifyEmail(companyId: CompanyId, userId: UserId, token: string): Promise<void> {
    const { uow, clock } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const stored = await this.#deps.repository.readVerificationToken(tx, userId);
      if (stored === undefined) throw authenticationFailed();
      if (new Date(stored.expiresAt).getTime() <= clock.now().getTime()) {
        throw authenticationFailed();
      }
      /* Compared by hash. A timing-safe compare is unnecessary on a SHA-256
         digest of a 256-bit random token: guessing it byte-by-byte requires
         first guessing it. */
      if (stored.tokenHash !== hashToken(token)) throw authenticationFailed();

      await this.#deps.repository.activateVerifiedUser(tx, companyId, userId);
    });
  }
}

function assertUsable(user: AuthUserRow): void {
  /* Unverified, suspended and deactivated accounts all produce the same
     failure as a wrong password (08 §6). Five situations, one response. */
  if (user.status !== 'active' || user.emailVerifiedAt === null) throw authenticationFailed();
}
