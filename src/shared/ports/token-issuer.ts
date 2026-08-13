import type { CompanyId, UserId } from '../types/ids.js';

/**
 * `TokenIssuerPort` — access-token minting (08 §3, SEC-013).
 *
 * The claim set is deliberately small. **No permission list travels in the
 * token** (SEC-013): permissions are resolved per request from `user_roles`,
 * because a token is valid for its whole lifetime and a revoked role must take
 * effect on the next request rather than in fifteen minutes.
 */

export interface AccessTokenClaims {
  /** User id. */
  readonly sub: UserId;
  /** Session id, so a token can be tied back to the session that issued it. */
  readonly sid: string;
  /** Company id. NULL for platform staff (D-005). */
  readonly cid: CompanyId | null;
  /** Active capability: 1 = organisation view, 2 = agency view (D-035). */
  readonly cap: number;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface TokenIssuerPort {
  issueAccessToken(claims: AccessTokenClaims): Promise<IssuedAccessToken>;
}

/**
 * Verification is a separate port from issuance.
 *
 * The API verifies but never issues on most paths, and a future service that
 * only validates tokens should not be handed a signing key by the type system.
 */
export interface VerifiedClaims {
  readonly sub: string;
  readonly sid: string;
  readonly cid: string | null;
  readonly cap: number;
}

export interface TokenVerifierPort {
  /** `undefined` for any invalid token. Never throws for a bad signature. */
  verifyAccessToken(token: string): Promise<VerifiedClaims | undefined>;
}
