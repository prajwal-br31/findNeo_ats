import { forbidden } from '../errors/app-error.js';

import type { ResolvedPermissions } from './permission-cache.js';

/**
 * The authorization decision (T-028, 04 §1).
 *
 * Separate from the Fastify hook that calls it so the same rule is callable
 * from the worker and from a test without a server (ER-004).
 */

/**
 * Routes acting on the caller's own account carry this instead of a permission
 * key. Editing your own profile is not something a role grants you, and
 * inventing a `self` permission for it would put it in the role matrix, where
 * someone would eventually take it away from a role and lock those users out
 * of their own settings.
 */
export const SELF_PERMISSION = 'self';

export function isSelfPermission(permission: string): boolean {
  return permission === SELF_PERMISSION;
}

/**
 * Throws `ERR_FORBIDDEN` unless the caller holds the permission.
 *
 * **403, not 404.** The tenant-scoped 404 rule (SEC-026) is about resources
 * belonging to another tenant — hiding their existence. This is a caller
 * inside the right tenant who lacks a capability, and telling them so is
 * correct: they already know the endpoint exists, and a 404 here would send
 * them hunting for a bug instead of asking for access.
 */
export function requirePermission(permissions: ResolvedPermissions, required: string): void {
  if (isSelfPermission(required)) return;
  if (permissions.keys.has(required)) return;
  throw forbidden('You do not have permission to perform this action.');
}
