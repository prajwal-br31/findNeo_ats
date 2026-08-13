import { describe, expect, it } from 'vitest';

import { QUEUE_DOMAINS } from '../../../shared/ports/queue.js';
import { unsafeCompanyId, type CompanyId } from '../../../shared/types/ids.js';
import { deadLetterQueue, partitionsFor, queueNameFor, queueNamesFor } from '../queue-routing.js';

/**
 * Phase 0 gate: `QueuePort`'s interface does not assume one queue per domain.
 *
 * Tenant fairness is deferred to T-159a, and D-040 leaves two strategies open —
 * a custom claim query (one queue per domain) or hash-partitioning (many). The
 * gate is not that partitioning works; it is that choosing it later does not
 * reach outside `platform/queue`.
 *
 * A seam that is never exercised at N > 1 is a seam in name only, so these
 * tests drive the routing functions at four partitions. Nothing in production
 * runs that way today — `partitionsFor` returns 1 — and that is asserted too.
 */

function tenant(index: number): CompanyId {
  return unsafeCompanyId(`01920000-0000-7000-8000-${String(index).padStart(12, '0')}`);
}

const TENANTS = Array.from({ length: 200 }, (_, index) => tenant(index));

describe('today: exactly one queue per domain', () => {
  it('every domain is backed by a single queue named after it', () => {
    for (const domain of QUEUE_DOMAINS) {
      expect(partitionsFor(domain)).toBe(1);
      expect(queueNamesFor(domain)).toEqual([domain]);
    }
  });

  it('routing is the identity, so no name changes when fairness lands unused', () => {
    for (const domain of QUEUE_DOMAINS) {
      expect(queueNameFor(domain, tenant(0))).toBe(domain);
    }
  });

  it('dead-letter names are unchanged from the per-domain form (ER-044)', () => {
    expect(deadLetterQueue('documents')).toBe('documents.dead');
    for (const domain of QUEUE_DOMAINS) {
      expect(deadLetterQueue(domain)).not.toBe(domain);
    }
  });
});

describe('the hash-partition strategy stays available without touching callers', () => {
  const PARTITIONS = 4;

  it('a domain can be backed by many queues', () => {
    expect(queueNamesFor('ai', PARTITIONS)).toEqual(['ai.0', 'ai.1', 'ai.2', 'ai.3']);
  });

  it('every routed name is one the worker would actually serve', () => {
    /* The failure this catches: routing and enumeration drifting apart, so
       jobs land on a queue no pool is watching and simply never run. */
    const served = new Set(queueNamesFor('ai', PARTITIONS));
    for (const tenant of TENANTS) {
      expect(served.has(queueNameFor('ai', tenant, PARTITIONS))).toBe(true);
    }
  });

  it('a tenant always routes to the same queue', () => {
    /* Stability is what keeps one tenant's jobs in order. An unstable hash
       would spread them across partitions and reorder them silently. */
    for (const tenant of TENANTS.slice(0, 20)) {
      const first = queueNameFor('ai', tenant, PARTITIONS);
      expect(queueNameFor('ai', tenant, PARTITIONS)).toBe(first);
    }
  });

  it('tenants actually spread across the partitions', () => {
    /* A hash that returned a constant would pass every test above and give
       the flooding tenant the whole domain anyway. */
    const used = new Set(TENANTS.map((tenant) => queueNameFor('ai', tenant, PARTITIONS)));
    expect(used.size).toBe(PARTITIONS);
  });

  it('each partition gets its own dead-letter queue', () => {
    const names = queueNamesFor('ai', PARTITIONS);
    const deadLetters = new Set(names.map(deadLetterQueue));
    expect(deadLetters.size).toBe(names.length);
  });
});
