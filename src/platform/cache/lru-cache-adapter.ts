import { LRUCache } from 'lru-cache';

import type { CachePort, CacheScope } from '../../shared/ports/cache.js';

/**
 * In-process LRU (D-017). Redis is a hosted-product decision if load ever
 * demands it, never a requirement pushed onto on-premise customers.
 *
 * The scope is folded into the physical key here, in one place — the only
 * place that could get it wrong (ER-024, SEC-008).
 */

const DEFAULT_MAX_ENTRIES = 5_000;

function physicalKey(scope: CacheScope, key: string): string {
  return scope.kind === 'global' ? `global\u0000${key}` : `t:${scope.companyId}\u0000${key}`;
}

export interface LruCacheOptions {
  readonly maxEntries?: number;
  readonly defaultTtlMs?: number;
}

export class LruCacheAdapter implements CachePort {
  readonly #cache: LRUCache<string, object>;

  constructor(options: LruCacheOptions = {}) {
    this.#cache = new LRUCache<string, object>({
      max: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      ...(options.defaultTtlMs === undefined ? {} : { ttl: options.defaultTtlMs }),
    });
  }

  get(scope: CacheScope, key: string): unknown {
    /* Boxed because lru-cache requires an object value, and a cached `false`
       or `0` must survive the round trip rather than read as a miss. */
    const boxed = this.#cache.get(physicalKey(scope, key));
    return boxed === undefined ? undefined : (boxed as { value: unknown }).value;
  }

  set(scope: CacheScope, key: string, value: unknown, ttlMs?: number): void {
    this.#cache.set(physicalKey(scope, key), { value }, ttlMs === undefined ? {} : { ttl: ttlMs });
  }

  delete(scope: CacheScope, key: string): void {
    this.#cache.delete(physicalKey(scope, key));
  }

  invalidateScope(scope: CacheScope): void {
    const prefix = physicalKey(scope, '');
    for (const key of [...this.#cache.keys()]) {
      if (key.startsWith(prefix)) this.#cache.delete(key);
    }
  }

  clear(): void {
    this.#cache.clear();
  }
}
