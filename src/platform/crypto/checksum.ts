import { createHash } from 'node:crypto';

/**
 * SHA-256 of a buffer, hex encoded.
 *
 * Lives in `platform` because `node:crypto` does (ER-011). The application
 * layer takes it as an injected function, so nothing above this line knows
 * which algorithm or which library produced the digest.
 *
 * Used for `candidate_resumes.checksum_sha256`, which is what lets the
 * per-application copy job verify it copied what it meant to (06b §1).
 */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
