import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for secrets held at rest (SEC-047).
 *
 * The one thing in this slice that needs it is `users.mfa_secret_encrypted`.
 * A TOTP seed is a bearer credential: anyone holding it can generate valid
 * codes forever, so storing it in plaintext under a column named
 * `_encrypted` would be worse than not having the column — it would read as
 * protected in every review that did not open this file.
 *
 * AES-256-GCM, so the ciphertext is authenticated. A malleable ciphertext on a
 * TOTP seed lets an attacker with write access swap in a seed they control,
 * which is indistinguishable from a legitimate re-enrolment.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The version
 * prefix exists so a future key rotation or algorithm change can be told apart
 * from a corrupt value rather than guessed at.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export class SecretBox {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== KEY_BYTES) {
      /* Length is checked here rather than trusted from config, because a
         short key silently produces working ciphertext with less strength —
         a failure with no symptom. */
      throw new SecretBoxError(
        `encryption key must decode to ${String(KEY_BYTES)} bytes, got ${String(key.length)}`,
      );
    }
    this.#key = key;
  }

  encrypt(plaintext: string): string {
    /* A fresh IV per encryption. Reusing one under GCM is catastrophic — it
       leaks the XOR of the plaintexts and breaks authentication entirely. */
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(envelope: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new SecretBoxError('ciphertext is not a v1 envelope');
    }

    const [, ivPart, tagPart, dataPart] = parts;
    const decipher = createDecipheriv(
      ALGORITHM,
      this.#key,
      Buffer.from(ivPart as string, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart as string, 'base64url'));

    /* Throws on a tag mismatch, which is the point: a tampered ciphertext must
       fail loudly rather than decrypt to garbage that some caller then uses. */
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart as string, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
