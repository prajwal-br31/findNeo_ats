import type { CompanyId } from '../types/ids.js';

import type { TxScope } from './unit-of-work.js';

/**
 * `QueuePort` (D-004, D-016, D-039, D-040).
 *
 * Two of this system's rules are enforced by the *shape* of `enqueue` rather
 * than by review:
 *
 *  - **It takes a `TxScope`.** A job is enqueued in the same transaction as
 *    the state change that triggers it (ER-028). pg-boss lives in the same
 *    database precisely so this works; enqueueing after commit loses jobs, and
 *    enqueueing before commit without a transaction fires them for rows that
 *    rolled back. There is deliberately no overload that omits it.
 *
 *  - **The payload extends `TenantJobPayload`.** Every payload carries
 *    `companyId` (ER-042a) — tenant fairness (D-040) and shard-readiness
 *    (D-041) both depend on it, and a handler cannot bind tenant context
 *    without it. Omitting it is a compile error, not a review comment.
 *
 * What the types cannot enforce, and review must: **payloads carry ids, never
 * entity snapshots** (ER-042). A snapshot is stale the moment it is written
 * and puts personal data in the job table, which ER-048 forbids outright.
 */

/** One queue, one worker pool, one policy (D-039). */
export const QUEUE_DOMAINS = [
  'communication',
  'ai',
  'documents',
  'integrations',
  'recruitment',
  'system',
] as const;

export type QueueDomain = (typeof QUEUE_DOMAINS)[number];

/**
 * Registering a job to a domain is a deliberate choice, not the nearest match
 * (ER-041a): an AI job in `communication` reintroduces the starvation the
 * split exists to prevent.
 */
export interface TenantJobPayload {
  readonly companyId: CompanyId;
}

export interface EnqueuedJob {
  readonly jobId: string;
  readonly domain: QueueDomain;
  readonly jobName: string;
}

export interface QueuePort {
  enqueue(
    tx: TxScope,
    domain: QueueDomain,
    jobName: string,
    payload: TenantJobPayload,
  ): Promise<EnqueuedJob>;
}
