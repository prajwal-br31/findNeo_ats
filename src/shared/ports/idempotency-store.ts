import type { CompanyId } from '../types/ids.js';

import type { TxScope } from './unit-of-work.js';

/**
 * Storage for the idempotency contract (07 §9, 06 §7).
 *
 * A port rather than a repository inside a module, because idempotency is
 * cross-cutting: every side-effecting POST in every module uses it, and it
 * belongs to no feature. Same shape as `UnitOfWorkPort` (D-044) — declared in
 * `shared/`, implemented in `platform/db`, and the only place that knows what
 * a `TxScope` is stays `platform/db`.
 */

export type IdempotencyStatus = 'in_flight' | 'completed';

export interface IdempotencyRecord {
  readonly id: string;
  readonly status: IdempotencyStatus;
  readonly requestHash: string;
  readonly responseStatus: number | null;
  readonly responseBody: unknown;
}

export interface ReservationInput {
  /** NULL for pre-tenant routes — signup has no company yet (06 §7). */
  readonly companyId: CompanyId | null;
  readonly endpoint: string;
  readonly key: string;
  /** SHA-256 of the canonicalised body. */
  readonly requestHash: string;
  readonly expiresAt: Date;
}

export type ReserveResult =
  | { readonly outcome: 'reserved'; readonly id: string }
  | { readonly outcome: 'exists'; readonly record: IdempotencyRecord };

export interface IdempotencyStorePort {
  /**
   * Claims the key, or reports the row that already holds it.
   *
   * Must be atomic against a concurrent caller — the unique index is what
   * makes that true, and it is why 06 §7 puts the row in before the handler
   * runs rather than after.
   */
  reserve(tx: TxScope, input: ReservationInput): Promise<ReserveResult>;

  /** Records the response so a later retry replays it instead of re-executing. */
  complete(tx: TxScope, id: string, responseStatus: number, responseBody: unknown): Promise<void>;

  /**
   * Drops a reservation whose handler failed.
   *
   * Without this a failed request would hold its key until expiry and the
   * client could not retry for 24 hours — turning a transient failure into a
   * day-long one.
   */
  release(tx: TxScope, id: string): Promise<void>;
}
