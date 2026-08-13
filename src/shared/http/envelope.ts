import { encodeCursor, type CursorPayload } from './cursor.js';

/**
 * Response envelopes (07 §5).
 *
 * A collection is `{ data, pagination }` and nothing else. A single resource
 * is returned **bare** — a wrapper there adds a level of nesting to every
 * client access for no benefit, so there is deliberately no `wrapOne()` here
 * to reach for.
 *
 * `_masked` and `_links` are the only permitted underscore-prefixed fields
 * (07 §5). `_masked` is populated by the masking layer at serialization
 * (T-029), not here.
 */

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

export interface Pagination {
  /** Opaque. Absent when there is no further page. */
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly limit: number;
}

export interface Collection<T> {
  readonly data: readonly T[];
  readonly pagination: Pagination;
}

/**
 * Builds a page from `limit + 1` rows.
 *
 * Fetching one extra row is how `hasMore` is answered without a count query —
 * 07 §5 rules out a total count because an accurate one costs a second scan
 * that dominates query cost on large tenants. The extra row is dropped here.
 */
export function paginate<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => CursorPayload,
): Collection<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  return {
    data,
    pagination: {
      ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(toCursor(last)) } : {}),
      hasMore,
      limit,
    },
  };
}

/**
 * Clamps a client-supplied limit into range (07 §4: default 25, max 100).
 * Clamped rather than rejected — an over-large limit is a client being
 * optimistic, not an attack, and 429 already covers volume.
 */
export function resolveLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_LIMIT);
}
