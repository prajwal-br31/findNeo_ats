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
  readonly mfa: MfaAdapters;
}

/**
 * TOTP and secret encryption, injected rather than imported.
 *
 * `otpauth` and node crypto both live in `platform/`, so the application layer
 * reaches them through this shape instead of importing them directly (ER-011).
 */
export interface MfaAdapters {
  begin(label: string): { secret: string; uri: string };
  verify(secret: string, label: string, code: string): boolean;
  encrypt(plaintext: string): string;
  decrypt(envelope: string): string;
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

      /* No role grant here (D-050). `trg_owner_requires_mfa` blocks granting
         super_admin to a user with mfa_enabled = false, and the founding owner
         has not enrolled yet. The grant moves to the end of MFA enrolment. */

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

    /* Starts untenanted — the tenant is not known until the email resolves —
       and binds once it is, before the session row is written. `sessions` is
       under FORCE RLS, so an unbound insert is rejected by the policy. */
    const outcome = await uow.withNewTenant<LoginResult | { failedUserId: string | null }>(
      async (tx: TxScope, bind) => {
        const user = await repository.findAuthUserByEmail(tx, email);

        /* **Always run the verification**, against a dummy hash when there is no
         user (SEC-015). Returning early here would make a nonexistent account
         answer in a millisecond and a real one in fifty — a timing oracle that
         needs no statistics to read. */
        const hashToCheck = user?.passwordHash ?? (await dummyHash());
        const passwordMatches = await hasher.verify(hashToCheck, password);

        /* Failures RETURN rather than throw. Throwing rolls the transaction
         back, and the lockout counter is written on exactly that path — so a
         thrown failure silently undid its own increment and the account could
         never lock, no matter how many attempts it took. The caller records
         the failure in its own committed transaction and throws there. */
        if (user === undefined) return { failedUserId: null };

        /* Locked accounts still ran the hash above, and still fail the same way.
         Revealing the lock tells an attacker their guessing is working, and
         tells anyone that the account exists. */
        if (isLocked(user.lockedUntil, clock.now())) return { failedUserId: null };

        if (!passwordMatches) return { failedUserId: user.id };

        if (!isUsable(user)) return { failedUserId: null };

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

        await bind(unsafeCompanyId(user.companyId));
        return this.#openSession(tx, user, meta);
      },
    );

    if (!('failedUserId' in outcome)) return outcome;

    /* A second, committed transaction. This is the one place login is
       deliberately two transactions rather than one (08 §5): the counter has
       to survive the failure it is counting. */
    if (outcome.failedUserId !== null) {
      const failedUserId = outcome.failedUserId;
      await uow.withoutTenant(async (tx: TxScope) => {
        await repository.recordFailedLogin(
          tx,
          failedUserId,
          FAILED_LOGIN_THRESHOLD,
          LOCKOUT_MINUTES,
        );
      });
    }

    throw authenticationFailed();
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

  /**
   * The founding grant, issued at MFA enrolment (D-050).
   *
   * Runs after `enableMfa` in the same transaction, so `trg_owner_requires_mfa`
   * sees `mfa_enabled = true` and permits the insert. If the flag were not set
   * first the trigger would reject this — which is the intended behaviour, not
   * something to work around.
   */
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

    /* The authentication lookup deliberately does not return `full_name` — it
       is a pre-tenant read path and returns credentials and status only. The
       display name is read here instead, which is fine: by this point the
       password has verified and the tenant is known. */
    const fullName = await repository.findFullName(tx, userId);

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
      user: { id: userId, email: user.email, fullName, companyId },
    };
  }

  /**
   * Completes MFA enrolment (D-050).
   *
   * One transaction, three effects that must not come apart:
   *   1. `mfa_enabled = true`,
   *   2. the founding `super_admin` grant, which the trigger permits only
   *      because (1) already happened in this transaction, and
   *   3. the company becomes `active`.
   *
   * Split across transactions, a crash between (1) and (2) leaves a tenant
   * with an MFA-enrolled owner holding no permissions and no way to grant
   * themselves any — an unrecoverable account, since the only role that can
   * assign roles is the one that failed to land.
   */
  async enableMfa(companyId: CompanyId, userId: UserId, code: string): Promise<void> {
    const { uow, repository, mfa } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const stored = await repository.readMfaSecret(tx, userId);
      if (stored === undefined) {
        throw new AppError('ERR_VALIDATION_FAILED', {
          detail: 'Start enrolment before submitting a code.',
        });
      }

      if (!mfa.verify(mfa.decrypt(stored.secret), stored.email, code)) {
        /* Same failure as any other authentication failure. A distinguishable
           "wrong code" tells a shoulder-surfer their capture was close. */
        throw authenticationFailed();
      }

      await repository.enableMfa(tx, userId);
      await this.#grantOwnerRole(tx, companyId, userId);
      await repository.activateCompany(tx, companyId);
    });
  }

  /**
   * Starts enrolment: mints a TOTP secret, stores it encrypted, and returns it
   * once. `mfa_enabled` stays false — the secret is useless to an attacker who
   * cannot also pass the code check, and useless to the user until they do.
   */
  async beginMfaEnrolment(
    companyId: CompanyId,
    userId: UserId,
  ): Promise<{ secret: string; uri: string }> {
    const { uow, repository, mfa } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const email = await repository.findEmail(tx, userId);
      const enrolment = mfa.begin(email);
      await repository.storeMfaSecret(tx, userId, mfa.encrypt(enrolment.secret));
      return enrolment;
    });
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

      await this.#deps.repository.activateVerifiedUser(tx, userId);
    });
  }
}

/**
 * Coerced rather than trusted: the lookup goes through a set-returning
 * function, where the driver hands `locked_until` back as a string rather than
 * a Date. Calling `.getTime()` on it threw a TypeError, which meant the lock
 * check never actually ran.
 */
function isLocked(lockedUntil: Date | string | null, now: Date): boolean {
  if (lockedUntil === null) return false;
  return new Date(lockedUntil).getTime() > now.getTime();
}

function isUsable(user: AuthUserRow): boolean {
  /* Unverified, suspended and deactivated accounts all produce the same
     failure as a wrong password (08 §6). Five situations, one response. */
  return user.status === 'active' && user.emailVerifiedAt !== null;
}
