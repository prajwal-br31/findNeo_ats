import type { QueueDomain } from '../../shared/ports/queue.js';
import type { CompanyId } from '../../shared/types/ids.js';

/**
 * Which physical queue backs a logical domain.
 *
 * ## Why this file exists
 *
 * `QueuePort` speaks in **domains** — `enqueue(tx, 'ai', …)`. It never names a
 * queue. This module is the only place that turns a domain into the queue name
 * pg-boss actually sees, and it is deliberately written as a one-to-**many**
 * mapping even though the answer today is always one.
 *
 * That is the Phase 0 gate item. Tenant fairness is deferred to T-159a, and
 * D-040 leaves two strategies open:
 *
 *  - a **custom claim query**, which keeps one queue per domain; or
 *  - **hash-partitioning** each domain into N sub-queues by `companyId`
 *    (`ai.0` … `ai.7`), which does not.
 *
 * If the domain name were used directly as the queue name — as it was in the
 * obvious first draft — the second strategy would mean editing every enqueue
 * site, every queue registration and every worker loop. With this seam it
 * means changing `partitionsFor` and nothing else. The cost of keeping the
 * option open now is this file; the cost of retrofitting it later is a change
 * across the whole system, which is exactly the kind of thing Phase 0 exists
 * to prevent.
 *
 * **Nothing here is fairness.** No cap, no claim strategy, no pg-boss
 * internals — those all land at T-159a.
 */

/**
 * Physical queues per domain. One, today, for every domain.
 *
 * Deliberately a function of the domain rather than a single constant: if
 * partitioning ever lands, `ai` will want more partitions than `system`, and a
 * per-domain answer costs nothing now.
 */
export function partitionsFor(domain: QueueDomain): number {
  return PARTITIONS[domain];
}

const PARTITIONS: Readonly<Record<QueueDomain, number>> = {
  communication: 1,
  ai: 1,
  documents: 1,
  integrations: 1,
  recruitment: 1,
  system: 1,
};

/**
 * Every queue backing a domain. Callers that need to cover a whole domain —
 * queue creation, the worker fleet — iterate this rather than assuming the
 * domain name is a queue name.
 */
export function queueNamesFor(domain: QueueDomain, partitions = partitionsFor(domain)): string[] {
  if (partitions <= 1) return [domain];
  return Array.from({ length: partitions }, (_, index) => `${domain}.${String(index)}`);
}

/**
 * Which queue a tenant's job goes to.
 *
 * Routing is by `companyId` (ER-042a) and must be **stable**: the same tenant
 * always lands on the same partition, or a partitioned domain would deliver
 * one tenant's jobs out of order across partitions.
 *
 * FNV-1a — not for security, only for spread. It is inlined rather than
 * imported so this file has no dependency that a future change might drop.
 */
export function queueNameFor(
  domain: QueueDomain,
  companyId: CompanyId,
  partitions = partitionsFor(domain),
): string {
  if (partitions <= 1) return domain;

  let hash = 0x811c9dc5;
  for (let index = 0; index < companyId.length; index += 1) {
    hash ^= companyId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${domain}.${String(hash % partitions)}`;
}

/**
 * The dead-letter partner of a **queue**, not of a domain (ER-044).
 *
 * Per queue rather than per domain for the same reason as the rest of this
 * file: under partitioning each partition needs its own, and pg-boss attaches
 * a dead letter to a queue. For a single-partition domain this still reads as
 * `documents.dead`.
 */
export function deadLetterQueue(queueName: string): string {
  return `${queueName}.dead`;
}
