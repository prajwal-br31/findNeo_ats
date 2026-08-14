import { tenantScope, type CachePort } from '../../../shared/ports/cache.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId } from '../../../shared/types/ids.js';
import { FieldVisibility, type FieldVisibilityRule } from '../../../shared/authz/masking.js';
import type { FieldVisibilityRepository } from '../infrastructure/field-visibility.repository.js';

/**
 * Resolves a company's field-visibility rules (T-029, D-025).
 *
 * A company rule beats the platform default for the same `(table, field)` —
 * `ORDER BY company_id NULLS LAST LIMIT 1` per field, done in SQL so the
 * precedence lives in one place.
 *
 * Cached per tenant. These change roughly never, and re-reading them on every
 * serialization would add a query to every list endpoint in the product.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_KEY = 'field-visibility';

export interface FieldVisibilityServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: FieldVisibilityRepository;
  readonly cache: CachePort;
}

type CachedRule = FieldVisibilityRule;

function narrowRules(value: unknown): CachedRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules: CachedRule[] = [];
  for (const entry of value) {
    const candidate = entry as Partial<CachedRule>;
    if (
      typeof candidate.tableName !== 'string' ||
      typeof candidate.fieldName !== 'string' ||
      typeof candidate.requiredPermission !== 'string'
    ) {
      /* A malformed entry means the whole cached value is untrustworthy.
         Discarding it costs one query; using it half-parsed would silently
         unmask whichever field failed to narrow. */
      return undefined;
    }
    rules.push({
      tableName: candidate.tableName,
      fieldName: candidate.fieldName,
      requiredPermission: candidate.requiredPermission,
    });
  }
  return rules;
}

export class FieldVisibilityService {
  readonly #deps: FieldVisibilityServiceDeps;

  constructor(deps: FieldVisibilityServiceDeps) {
    this.#deps = deps;
  }

  async resolveIn(tx: TxScope, companyId: CompanyId): Promise<FieldVisibility> {
    const { repository, cache } = this.#deps;
    const scope = tenantScope(companyId);

    const cached = narrowRules(cache.get(scope, CACHE_KEY));
    if (cached !== undefined) return new FieldVisibility(cached);

    const rules = await repository.rulesFor(tx);
    cache.set(scope, CACHE_KEY, rules, CACHE_TTL_MS);
    return new FieldVisibility(rules);
  }

  async resolve(companyId: CompanyId): Promise<FieldVisibility> {
    const { uow } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => this.resolveIn(tx, companyId));
  }
}
