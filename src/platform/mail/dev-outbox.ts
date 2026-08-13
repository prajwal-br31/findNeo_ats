/**
 * The development outbox (08 §7).
 *
 * Signup issues an email-verification token that is never returned in the
 * response — returning it would make the "prove you own the address" step
 * decorative. In development there is no inbox to read it from, so the last
 * one is held here and served by a dev-only route.
 *
 * **Only ever populated when `NODE_ENV=development`.** The route that reads it
 * is registered under the same condition, so in any other environment this
 * holds nothing and nothing can ask for it. Two independent guards, because
 * one of them is the kind of thing that gets refactored away.
 */

export interface DevEmail {
  readonly to: string;
  readonly template: string;
  /** The raw token, which exists nowhere else — the database holds its hash. */
  readonly token: string;
  readonly companyId: string;
  readonly userId: string;
  readonly capturedAt: string;
}

let lastEmail: DevEmail | undefined;

export function recordDevEmail(email: DevEmail): void {
  lastEmail = email;
}

export function readLastDevEmail(): DevEmail | undefined {
  return lastEmail;
}

/** Exported for tests, which must not inherit another test's token. */
export function clearDevOutbox(): void {
  lastEmail = undefined;
}
