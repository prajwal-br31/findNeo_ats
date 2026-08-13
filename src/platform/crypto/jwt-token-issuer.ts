import { randomUUID } from 'node:crypto';

import { importPKCS8, SignJWT, type KeyLike } from 'jose';

import type { ClockPort } from '../../shared/ports/clock.js';
import type {
  AccessTokenClaims,
  IssuedAccessToken,
  TokenIssuerPort,
} from '../../shared/ports/token-issuer.js';

/**
 * Access tokens, signed EdDSA with the configured private key.
 *
 * `jose` over `jsonwebtoken` (05a §5): strict algorithm handling. The
 * algorithm is pinned at signing *and* must be pinned at verification —
 * accepting whatever the header claims is the algorithm-confusion class of
 * bug, and it is the reason `jsonwebtoken` is on the rejected list.
 */

/** 15 minutes (08 §3). Short, because a token cannot be revoked mid-life. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export const ACCESS_TOKEN_ALGORITHM = 'EdDSA';
const ISSUER = 'findneo';
const AUDIENCE = 'findneo-api';

export class JwtTokenIssuer implements TokenIssuerPort {
  readonly #privateKeyPem: string;
  readonly #clock: ClockPort;
  #key: KeyLike | undefined;

  constructor(privateKeyPem: string, clock: ClockPort) {
    this.#privateKeyPem = privateKeyPem;
    this.#clock = clock;
  }

  async #signingKey(): Promise<KeyLike> {
    /* Imported once and cached: key import is not free, and doing it per
       request turns token issuance into the slowest part of login. */
    this.#key ??= await importPKCS8(this.#privateKeyPem, ACCESS_TOKEN_ALGORITHM);
    return this.#key;
  }

  async issueAccessToken(claims: AccessTokenClaims): Promise<IssuedAccessToken> {
    const issuedAt = this.#clock.now();
    const expiresAt = new Date(issuedAt.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);

    const token = await new SignJWT({
      sid: claims.sid,
      cid: claims.cid,
      cap: claims.cap,
    })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      /* A unique id per token, so an individual token can be denylisted
         without revoking its session. */
      .setJti(randomUUID())
      .sign(await this.#signingKey());

    return { token, expiresAt };
  }
}
