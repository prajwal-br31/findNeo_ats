import type { QueueDomain } from '../../shared/ports/queue.js';

/**
 * Per-domain policy (05 §5, D-039, ER-044).
 *
 * Declared as configuration, never hard-coded per job: a job registers to a
 * domain and inherits the domain's concurrency, retry, backoff and timeout.
 * Six domains, six pools — that split is the only reason an interview reminder
 * stays fast while a bulk embedding run is in flight.
 *
 * `tenantCap` is the per-tenant in-flight limit D-040 enforces in the claim
 * path. It lives here because it is policy, not mechanism.
 */

export type QueuePriority = 'high' | 'normal' | 'low' | 'lowest';

export interface QueuePolicy {
  readonly concurrency: number;
  readonly priority: QueuePriority;
  readonly retries: number;
  readonly backoff: boolean;
  /** Per-tenant in-flight cap within this domain (D-040). */
  readonly tenantCap: number;
  readonly timeoutSeconds: number;
}

/** pg-boss orders by `priority DESC`, so higher wins. */
export const PRIORITY_VALUES: Readonly<Record<QueuePriority, number>> = {
  high: 100,
  normal: 50,
  low: 10,
  lowest: 0,
};

export const QUEUE_POLICIES: Readonly<Record<QueueDomain, QueuePolicy>> = {
  // Latency-sensitive, must never starve.
  communication: {
    concurrency: 20,
    priority: 'high',
    retries: 5,
    backoff: true,
    tenantCap: 5,
    timeoutSeconds: 60,
  },
  // Slow, bursty, expensive — the workload the domain split exists to contain.
  ai: {
    concurrency: 4,
    priority: 'low',
    retries: 2,
    backoff: true,
    tenantCap: 1,
    timeoutSeconds: 300,
  },
  documents: {
    concurrency: 8,
    priority: 'normal',
    retries: 3,
    backoff: false,
    tenantCap: 3,
    timeoutSeconds: 120,
  },
  // Unreliable upstreams, so retry hardest here.
  integrations: {
    concurrency: 10,
    priority: 'normal',
    retries: 6,
    backoff: true,
    tenantCap: 3,
    timeoutSeconds: 60,
  },
  recruitment: {
    concurrency: 4,
    priority: 'low',
    retries: 3,
    backoff: false,
    tenantCap: 2,
    timeoutSeconds: 120,
  },
  system: {
    concurrency: 2,
    priority: 'lowest',
    retries: 2,
    backoff: false,
    tenantCap: 1,
    timeoutSeconds: 300,
  },
};

/** Dead letters go to a per-domain queue, never back onto the live one. */
export function deadLetterQueue(domain: QueueDomain): string {
  return `${domain}.dead`;
}
