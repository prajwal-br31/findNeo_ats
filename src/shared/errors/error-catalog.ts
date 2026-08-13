/**
 * The error catalog (07 §6, D-021, ER-037).
 *
 * **`code` is the contract.** Clients branch on it. `title` and `detail` are
 * human-facing and may be reworded or localised at any time, so nothing may
 * depend on them. Adding a code is routine; changing what one *means* is a
 * breaking change.
 *
 * One catalog, defined once. An ad-hoc error shape invented at a call site is
 * a contract change nobody reviewed.
 */

interface CatalogEntry {
  readonly status: number;
  readonly title: string;
}

export const ERROR_CATALOG = {
  ERR_MALFORMED_REQUEST: { status: 400, title: 'Malformed request' },
  ERR_UNAUTHENTICATED: { status: 401, title: 'Unauthenticated' },
  ERR_TOKEN_EXPIRED: { status: 401, title: 'Token expired' },
  ERR_MFA_REQUIRED: { status: 401, title: 'MFA required' },
  ERR_FORBIDDEN: { status: 403, title: 'Forbidden' },
  ERR_CAPABILITY_MISMATCH: { status: 403, title: 'Capability mismatch' },
  ERR_NOT_FOUND: { status: 404, title: 'Not found' },
  ERR_CONFLICT: { status: 409, title: 'Conflict' },
  ERR_INVALID_TRANSITION: { status: 409, title: 'Invalid transition' },
  ERR_DUPLICATE: { status: 409, title: 'Duplicate' },
  ERR_IDEMPOTENCY_CONFLICT: { status: 409, title: 'Idempotency conflict' },
  ERR_TOKEN_CONSUMED: { status: 410, title: 'Token consumed' },
  ERR_PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  ERR_UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  ERR_VALIDATION_FAILED: { status: 422, title: 'Validation failed' },
  ERR_BUSINESS_RULE_VIOLATION: { status: 422, title: 'Business rule violation' },
  ERR_APPLICATION_CAP_REACHED: { status: 422, title: 'Application cap reached' },
  ERR_RATE_LIMITED: { status: 429, title: 'Rate limited' },
  ERR_INTERNAL: { status: 500, title: 'Internal error' },
  ERR_SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable' },
} as const satisfies Record<string, CatalogEntry>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

const TYPE_BASE = 'https://errors.findneo.com/';

/**
 * Derived from the code rather than stored, so the two can never disagree.
 * `ERR_VALIDATION_FAILED` → `https://errors.findneo.com/validation-failed`.
 */
export function errorTypeUri(code: ErrorCode): string {
  return TYPE_BASE + code.replace(/^ERR_/, '').toLowerCase().replaceAll('_', '-');
}

export function catalogEntry(code: ErrorCode): CatalogEntry {
  return ERROR_CATALOG[code];
}

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_CATALOG, value);
}

/**
 * Per-field codes for `fields[]`. Open-ended by design — validation grows new
 * failure kinds — but the two the specification names are fixed here so they
 * cannot drift.
 *
 * The exhaustive list arrives with T-010, which maps Ajv's error keywords onto
 * these; it is not invented here.
 */
export const FIELD_ERROR_CODES = {
  REQUIRED: 'ERR_FIELD_REQUIRED',
  RANGE: 'ERR_FIELD_RANGE',
} as const;
