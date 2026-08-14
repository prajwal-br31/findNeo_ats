import type { CompanyId, UserId } from '../types/ids.js';

/**
 * The permission cache key (T-027, 08 §3, ER-024).
 *
 * `(companyId, userId, rolesVersion)`.
 *
 * **The tenant portion is mandatory** (ER-024). One process caches many
 * tenants, and a key of `userId` alone would serve one company's permissions
 * to another the moment two tenants happened to share a user id — or, far more
 * likely, the moment somebody introduced a numeric or sequential id.
 *
 * `rolesVersion` is a per-company counter bumped by a database trigger on any
 * role change (migration 020). Including it means a revocation invalidates
 * every cached entry for that company *by making their keys unreachable* —
 * no flush, no cross-process coordination, and the effect lands on the next
 * request rather than after a TTL. A TTL alone would keep a revoked role live
 * for its duration, which is exactly the window that matters when someone is
 * being removed for cause.
 */

export function permissionCacheKey(
  companyId: CompanyId,
  userId: UserId,
  rolesVersion: number,
): string {
  /* The company id appears here *as well as* in the CacheScope the port
     requires. Redundant on purpose: the scope is the structural guarantee, and
     this is the one that survives someone refactoring the scope away. */
  return `perm:${companyId}:${userId}:${String(rolesVersion)}`;
}

/**
 * A resolved permission set.
 *
 * `departmentIds` travels with it because department scope is evaluated on
 * every `◐` query (04 §4) and re-reading it per request would undo the point
 * of caching the permissions.
 */
export interface ResolvedPermissions {
  readonly keys: ReadonlySet<string>;
  readonly departmentIds: readonly string[];
}
