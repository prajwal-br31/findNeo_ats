import type { ClockPort } from '../../../shared/ports/clock.js';
import type { PasswordHasherPort } from '../../../shared/ports/password-hasher.js';
import type { QueuePort } from '../../../shared/ports/queue.js';
import type { TokenIssuerPort } from '../../../shared/ports/token-issuer.js';
import type { UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type { IdentityRepository } from '../infrastructure/identity.repository.js';

/** The shapes `AuthService` takes and returns. */

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
