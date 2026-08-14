import { createHash, randomBytes } from 'node:crypto';

/** Token minting and error narrowing, shared by the identity services. */

/** Tokens are stored hashed and compared by hash (ER-047). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * 32 bytes of CSPRNG output. Not a UUID: a UUIDv4 carries 122 bits and is
 * structured, and these are bearer credentials.
 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * True for a specific unique-constraint violation.
 *
 * Walks the `cause` chain: Drizzle wraps the driver error in a
 * `DrizzleQueryError`, so `code` and `constraint` are one or two levels down.
 * Reading them off the top-level object silently never matches, which turns an
 * intended 422 into a 500 — and a 500 that looks exactly like a bug.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === constraint) return true;
    current = candidate.cause;
  }
  return false;
}
