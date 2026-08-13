import type { CompanyId } from '../types/ids.js';

/**
 * `CachePort` (D-017, ER-024, SEC-008).
 *
 * One process caches many tenants, so **an unkeyed entry is a cross-tenant
 * leak**. ER-024 requires the tenant portion to be structurally required
 * rather than conventional — hence `CacheScope` as a parameter in its own
 * right, not a substring a caller is trusted to prepend.
 *
 * The global case is a discriminated variant rather than a nullable tenant, so
 * reaching for it is a deliberate, greppable act. `{ global: true }` shows up
 * in review; a stray `null` does not.
 *
 * Accepted trade-off (D-017): with several instances behind a load balancer
 * each keeps its own copy, so a change may take minutes to propagate. Fine for
 * values that change monthly — the permission catalog, field visibility rules,
 * form template definitions.
 */

export type CacheScope =
  | { readonly kind: 'tenant'; readonly companyId: CompanyId }
  /** Platform-wide values: the permission catalog, platform-default roles. */
  | { readonly kind: 'global' };

export function tenantScope(companyId: CompanyId): CacheScope {
  return { kind: 'tenant', companyId };
}

export const GLOBAL_SCOPE: CacheScope = { kind: 'global' };

export interface CachePort {
  /**
   * `unknown`, not a caller-chosen `<T>`. A cache cannot verify what it hands
   * back, and `get<T>()` is an unchecked cast wearing a type parameter —
   * ER-013 says `unknown` at boundaries, then narrow. A typed view over this
   * arrives with the first real consumer (T-027's permission cache).
   */
  get(scope: CacheScope, key: string): unknown;
  set(scope: CacheScope, key: string, value: unknown, ttlMs?: number): void;
  delete(scope: CacheScope, key: string): void;
  /** Drops one tenant's entries — for when a tenant's permissions change. */
  invalidateScope(scope: CacheScope): void;
  clear(): void;
}
