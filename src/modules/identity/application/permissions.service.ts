import { tenantScope, type CachePort } from '../../../shared/ports/cache.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import {
  permissionCacheKey,
  type ResolvedPermissions,
} from '../../../shared/authz/permission-cache.js';
import type { IdentityRepository } from '../infrastructure/identity.repository.js';

/**
 * Permission resolution (T-027, 08 §3).
 *
 * `user_roles -> role_permissions -> permission keys`, cached in-process and
 * keyed by `(companyId, userId, rolesVersion)`.
 *
 * **No permission list ever travels in a token** (SEC-013). A token is valid
 * for its whole lifetime, so a permission baked into one survives a
 * revocation until it expires. Resolving per request is what makes "revoked
 * takes effect on the next request" true.
 */

/**
 * A ceiling, not the invalidation mechanism.
 *
 * `rolesVersion` handles correctness; this only bounds how long an entry for a
 * *deleted* user or company can sit in memory. Five minutes because the cost
 * of a miss is two indexed queries.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface PermissionsServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: IdentityRepository;
  readonly cache: CachePort;
}

function narrowCached(value: unknown): ResolvedPermissions | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined;
  const candidate = value as { keys?: unknown; departmentIds?: unknown };
  if (!Array.isArray(candidate.keys) || !Array.isArray(candidate.departmentIds)) return undefined;
  return {
    keys: new Set(candidate.keys.filter((key): key is string => typeof key === 'string')),
    departmentIds: candidate.departmentIds.filter((id): id is string => typeof id === 'string'),
  };
}

export class PermissionsService {
  readonly #deps: PermissionsServiceDeps;

  constructor(deps: PermissionsServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Resolves inside an existing transaction.
   *
   * Taking a `TxScope` rather than opening its own means the authorization
   * check and the work it authorizes see the same snapshot — a role revoked
   * between the two would otherwise let a request through on permissions the
   * database no longer agrees with.
   */
  async resolveIn(tx: TxScope, companyId: CompanyId, userId: UserId): Promise<ResolvedPermissions> {
    const { repository, cache } = this.#deps;

    /* The version is read every time, uncached. That is the point: it is the
       one query that cannot be skipped, because it is what tells us whether
       everything else may be. One indexed primary-key lookup. */
    const rolesVersion = await repository.rolesVersion(tx, companyId);
    const scope = tenantScope(companyId);
    const key = permissionCacheKey(companyId, userId, rolesVersion);

    /* `unknown` in, narrowed here (ER-013). A cache cannot verify what it
       hands back, and trusting its shape is how a stale serialization becomes
       a permission set with undefined members. */
    const cached = cache.get(scope, key);
    const narrowed = narrowCached(cached);
    if (narrowed !== undefined) return narrowed;

    const keys = await repository.resolvePermissionKeys(tx, userId);
    const departmentIds = await repository.departmentIdsFor(tx, userId);

    cache.set(scope, key, { keys, departmentIds }, CACHE_TTL_MS);
    return { keys: new Set(keys), departmentIds };
  }

  /** Opens its own transaction. For callers outside a request. */
  async resolve(companyId: CompanyId, userId: UserId): Promise<ResolvedPermissions> {
    const { uow } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => this.resolveIn(tx, companyId, userId));
  }
}
