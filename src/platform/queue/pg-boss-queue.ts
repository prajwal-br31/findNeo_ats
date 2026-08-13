import PgBoss from 'pg-boss';

import {
  QUEUE_DOMAINS,
  type EnqueuedJob,
  type QueueDomain,
  type QueuePort,
  type TenantJobPayload,
} from '../../shared/ports/queue.js';
import type { TxScope } from '../../shared/ports/unit-of-work.js';
import { unwrapTxConnection } from '../db/tx-scope.js';

import { PRIORITY_VALUES, QUEUE_POLICIES } from './queue-policies.js';
import { deadLetterQueue, queueNameFor, queueNamesFor } from './queue-routing.js';

/**
 * `QueuePort` over pg-boss (D-016, D-039).
 *
 * **Enqueue uses public API.** pg-boss's `send()` accepts a `db` executor —
 * `SendOptions` extends `ConnectionOptions` — so the insert runs on the
 * caller's own transaction and commits or rolls back with it (ER-028). No
 * writing to pg-boss's tables, and no coupling to its schema on this path.
 *
 * D-040's custom claim query is the one place that does reach inside, and it
 * is isolated in the fetch path with its own guards. Enqueue is deliberately
 * not part of that surface.
 */

/** The envelope stored in pg-boss's `data` column. Ids only (ER-042). */
export interface JobEnvelope {
  readonly jobName: string;
  readonly payload: TenantJobPayload;
}

/**
 * Adapts a `TxScope` to the executor shape pg-boss expects.
 *
 * `unwrapTxConnection` applies the same validity rules as any other scope use:
 * a forged or expired scope throws rather than silently enqueueing outside a
 * transaction.
 */
function executorFor(tx: TxScope): { executeSql: PgBoss.Db['executeSql'] } {
  const connection = unwrapTxConnection(tx);
  return {
    executeSql: async (text: string, values: unknown[]) => connection.query(text, values),
  };
}

export class PgBossQueue implements QueuePort {
  readonly #boss: PgBoss;

  constructor(boss: PgBoss) {
    this.#boss = boss;
  }

  async enqueue(
    tx: TxScope,
    domain: QueueDomain,
    jobName: string,
    payload: TenantJobPayload,
  ): Promise<EnqueuedJob> {
    const policy = QUEUE_POLICIES[domain];
    const envelope: JobEnvelope = { jobName, payload };
    /* The caller named a domain. Which queue that is, is this adapter's
       business and nobody else's — see queue-routing.ts. */
    const queueName = queueNameFor(domain, payload.companyId);

    const jobId = await this.#boss.send(queueName, envelope, {
      db: executorFor(tx),
      priority: PRIORITY_VALUES[policy.priority],
      retryLimit: policy.retries,
      retryBackoff: policy.backoff,
      expireInSeconds: policy.timeoutSeconds,
    });

    if (jobId === null) {
      /* pg-boss returns null when a singleton policy suppresses the insert.
         No domain uses one, so this means the queue is missing — which is a
         wiring error, not a runtime condition to swallow. */
      throw new Error(
        `queue "${queueName}" did not accept job "${jobName}". ` +
          'Was createQueues() called at startup?',
      );
    }

    return { jobId, domain, jobName };
  }
}

/**
 * Creates the six domain queues and their dead-letter partners.
 *
 * pg-boss 10 partitions its job table by queue name, so a queue must exist
 * before anything can be enqueued to it. Idempotent — safe on every boot.
 *
 * A dead letter goes to a per-domain queue and never back onto the live one
 * (ER-044): a job that fails permanently must become visible, not circulate.
 */
export async function createQueues(boss: PgBoss): Promise<void> {
  for (const domain of QUEUE_DOMAINS) {
    const policy = QUEUE_POLICIES[domain];

    /* Every queue backing the domain, not the domain name — a domain is one
       queue today and need not stay that way (see queue-routing.ts). */
    for (const queueName of queueNamesFor(domain)) {
      const dead = deadLetterQueue(queueName);
      await boss.createQueue(dead);
      await boss.createQueue(queueName, {
        name: queueName,
        policy: 'standard',
        retryLimit: policy.retries,
        retryBackoff: policy.backoff,
        expireInSeconds: policy.timeoutSeconds,
        deadLetter: dead,
      });
    }
  }
}
