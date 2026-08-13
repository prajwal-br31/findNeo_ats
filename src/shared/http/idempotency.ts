import { createHash, timingSafeEqual } from 'node:crypto';

import { AppError } from '../errors/app-error.js';
import type { IdempotencyStorePort } from '../ports/idempotency-store.js';
import type { TxScope, UnitOfWorkPort } from '../ports/unit-of-work.js';
import type { CompanyId } from '../types/ids.js';

/**
 * The idempotency contract (07 §9, ER-040).
 *
 * | Situation                        | Behaviour                          |
 * |----------------------------------|------------------------------------|
 * | New key                          | Process, store, return             |
 * | Same key, same body hash         | Return the stored response         |
 * | Same key, different body         | 409 `ERR_IDEMPOTENCY_CONFLICT`     |
 * | Same key, first request in flight| 409 with `Retry-After`             |
 * | Missing key where required       | 422, never a silent pass           |
 *
 * **The reservation commits in its own transaction, before the handler runs.**
 * That is what makes the in-flight case a 409 rather than a block: a
 * concurrent duplicate sees a committed row and answers immediately, instead
 * of waiting on an uncommitted insert and holding a connection. It is also why
 * `abandon` exists — a reservation whose handler failed must be released, or a
 * transient error would lock the key for 24 hours.
 *
 * Framework-agnostic on purpose. Fastify wiring is T-012; a worker replaying a
 * job uses the same functions.
 */

const RETENTION_HOURS = 24;
const RETRY_AFTER_SECONDS = 1;

export class IdempotencyInFlightError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number = RETRY_AFTER_SECONDS) {
    super('ERR_IDEMPOTENCY_CONFLICT', {
      detail: 'A request with this Idempotency-Key is still in progress. Retry shortly.',
    });
    this.name = 'IdempotencyInFlightError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface IdempotencyDeps {
  readonly uow: UnitOfWorkPort;
  readonly store: IdempotencyStorePort;
  /** Injected so retention is testable without sleeping (D-004, ClockPort). */
  readonly now: () => Date;
}

export interface IdempotentRequest {
  /** NULL for pre-tenant routes such as signup. */
  readonly companyId: CompanyId | null;
  /** Scopes the key, so one key cannot be reused across routes. */
  readonly endpoint: string;
  readonly key: string | undefined;
  readonly body: unknown;
}

export type IdempotencyDecision =
  | { readonly kind: 'proceed'; readonly reservationId: string }
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown };

/**
 * Stable stringify: object keys sorted at every depth, so two bodies that
 * differ only in key order hash the same. A client that re-serializes its
 * retry — which most HTTP libraries do — must not be told its body changed.
 */
function canonicalise(value: unknown): string {
  // An absent body and an explicit `null` body hash the same, deliberately.
  // They are the same request, and distinguishing them would 409 a client that
  // omitted the body on retry having sent `null` the first time.
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Constant-time comparison (ER-052).
 *
 * A request-body digest is not a secret, so the timing channel here leaks
 * nothing an attacker does not already know — but ER-052 says hash comparison
 * is timing-safe, and complying costs three lines where arguing for a
 * suppression costs every future reader the same re-evaluation.
 */
function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  // timingSafeEqual throws on unequal lengths; a digest length is fixed anyway.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(canonicalise(body), 'utf8').digest('hex');
}

/** Pre-tenant routes have no company to bind; everything else does (06 §7). */
async function inScope<T>(
  deps: IdempotencyDeps,
  companyId: CompanyId | null,
  fn: (tx: TxScope) => Promise<T>,
): Promise<T> {
  return companyId === null ? deps.uow.withoutTenant(fn) : deps.uow.withTenant(companyId, fn);
}

/**
 * @throws {AppError} 422 when the key is missing, 409 when it conflicts.
 */
export async function beginIdempotent(
  deps: IdempotencyDeps,
  request: IdempotentRequest,
): Promise<IdempotencyDecision> {
  if (request.key === undefined || request.key === '') {
    throw new AppError('ERR_VALIDATION_FAILED', {
      detail: 'This endpoint requires an Idempotency-Key header.',
    });
  }

  const hash = requestHash(request.body);
  const expiresAt = new Date(deps.now().getTime() + RETENTION_HOURS * 60 * 60 * 1000);

  const key = request.key;
  const result = await inScope(deps, request.companyId, async (tx) =>
    deps.store.reserve(tx, {
      companyId: request.companyId,
      endpoint: request.endpoint,
      key,
      requestHash: hash,
      expiresAt,
    }),
  );

  if (result.outcome === 'reserved') return { kind: 'proceed', reservationId: result.id };

  const { record } = result;
  if (!hashesEqual(record.requestHash, hash)) {
    throw new AppError('ERR_IDEMPOTENCY_CONFLICT', {
      detail: 'This Idempotency-Key was already used with a different request body.',
    });
  }
  if (record.status === 'in_flight') throw new IdempotencyInFlightError();

  return { kind: 'replay', status: record.responseStatus ?? 200, body: record.responseBody };
}

/** Records the response, so the next retry replays rather than re-executes. */
export async function finishIdempotent(
  deps: IdempotencyDeps,
  companyId: CompanyId | null,
  reservationId: string,
  status: number,
  body: unknown,
): Promise<void> {
  await inScope(deps, companyId, async (tx) =>
    deps.store.complete(tx, reservationId, status, body),
  );
}

/** Releases a reservation whose handler failed, so the client may retry. */
export async function abandonIdempotent(
  deps: IdempotencyDeps,
  companyId: CompanyId | null,
  reservationId: string,
): Promise<void> {
  await inScope(deps, companyId, async (tx) => deps.store.release(tx, reservationId));
}
