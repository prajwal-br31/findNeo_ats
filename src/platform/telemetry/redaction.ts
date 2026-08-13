/**
 * The redaction list of `12` §1, applied at any depth.
 *
 * ER-048 is the primary control: personal data never reaches a log call in the
 * first place. This is the **second** defence, and it is written to hold when
 * the first one fails — which is the only time it matters.
 *
 * Pino's own `redact` takes path patterns like `*.email`, which match one
 * level down. `{ candidate: { profile: { email } } }` is three levels down and
 * would pass straight through. Since the whole point of a backstop is to catch
 * what nobody predicted, matching happens on the **key name at any depth**
 * instead of on a path.
 */

/** Exactly the keys named in `12` §1, plus their snake_case row equivalents. */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'tokenHash',
  'token_hash',
  'refreshToken',
  'refresh_token',
  'mfaSecret',
  'mfa_secret',
  'email',
  'phone',
  'fullName',
  'full_name',
  'firstName',
  'first_name',
  'lastName',
  'last_name',
  'salaryMin',
  'salary_min',
  'salaryMax',
  'salary_max',
  'currentCtc',
  'current_ctc',
  'expectedCtc',
  'expected_ctc',
  'rawText',
  'raw_text',
  'comments',
  'bodyRendered',
  'body_rendered',
  'authorization',
  'cookie',
  'setCookie',
  'set-cookie',
]);

export const REDACTED = '[redacted]';

/** Deep structures in a log line are a smell; this also bounds the walk. */
const MAX_DEPTH = 8;

export function isRedactedKey(key: string): boolean {
  return REDACTED_KEYS.has(key);
}

/**
 * Returns a copy with every matching key censored, at any depth.
 *
 * Non-plain values — Buffers, Dates, class instances — are passed through
 * rather than walked: a Date has no personal keys, and walking arbitrary class
 * instances in a logger is how a logger starts throwing.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value instanceof Date || Buffer.isBuffer(value)) return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(source)) {
    result[key] = isRedactedKey(key) ? REDACTED : redactDeep(member, depth + 1);
  }
  return result;
}
