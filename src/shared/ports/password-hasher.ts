/**
 * `PasswordHasherPort` (SEC-014, ER-011).
 *
 * A port rather than a direct import because `@node-rs/argon2` is a
 * platform-only package: the application layer must not know which algorithm
 * is in use, so raising parameters or replacing the library is a change in one
 * adapter rather than everywhere a password is checked.
 */

export interface PasswordHasherPort {
  hash(plaintext: string): Promise<string>;

  /**
   * Verifies a plaintext against a stored hash.
   *
   * **Returns false rather than throwing on a malformed hash.** Login calls
   * this against a dummy hash when the account does not exist (SEC-015), and
   * an exception on that path would take a different amount of time — and a
   * different code path — than a real mismatch, which is exactly the timing
   * signal the dummy exists to suppress.
   */
  verify(hash: string, plaintext: string): Promise<boolean>;

  /**
   * True when `hash` was produced with weaker parameters than current policy.
   *
   * Existing hashes carry their own parameters, so raising the cost factor
   * does not invalidate them — they are rehashed on the next successful login
   * (05a §5). Without this, raising parameters protects only new accounts.
   */
  needsRehash(hash: string): boolean;
}
