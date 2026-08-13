import { AppError, ValidationError } from '../../shared/errors/app-error.js';

/**
 * Identity errors (08 §6).
 *
 * The authentication failures are deliberately indistinguishable from outside.
 * Bad password, no such account, unverified email, locked account and expired
 * account all produce the *same* code, the same status, and the same detail
 * string — because distinguishing them is an account-enumeration oracle, and
 * an attacker who can tell "wrong password" from "no such user" has a verified
 * list of your customers' email addresses.
 *
 * That is why there is one constructor for all of them rather than five. A
 * helper per case is an invitation to return the specific one "just for
 * debugging", and it survives to production.
 */

/** The single authentication failure. Never varied, never elaborated. */
export function authenticationFailed(): AppError {
  return new AppError('ERR_UNAUTHENTICATED', {
    detail: 'Email or password is incorrect.',
  });
}

/**
 * Slug collision (08 §6) — a generic 422, never "that company already exists".
 *
 * Reported against the field so the client can render it, but the message says
 * only that the value is unavailable. Confirming which slugs are taken maps
 * the customer list of a multi-tenant product from an unauthenticated endpoint.
 */
export function slugUnavailable(): ValidationError {
  return new ValidationError([
    {
      path: '/slug',
      code: 'ERR_FIELD_NOT_UNIQUE',
      message: 'This value is not available.',
    },
  ]);
}

export function reservedSlug(): ValidationError {
  return new ValidationError([
    { path: '/slug', code: 'ERR_FIELD_NOT_UNIQUE', message: 'This value is not available.' },
  ]);
}
