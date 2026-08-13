import type PgBoss from 'pg-boss';

import type { Config } from '../platform/config/config.types.js';
import { QUEUE_POLICIES } from '../platform/queue/queue-policies.js';
import { deadLetterQueue, queueNamesFor } from '../platform/queue/queue-routing.js';
import type { JobEnvelope } from '../platform/queue/pg-boss-queue.js';
import { QUEUE_DOMAINS, type QueueDomain, type TenantJobPayload } from '../shared/ports/queue.js';
import type { TxScope, UnitOfWorkPort } from '../shared/ports/unit-of-work.js';

/**
 * T-013 — the worker fleet (05 §5, D-039).
 *
 * Six domains, one pool each, each pool sized and retried by its own policy.
 * Which domains *this* process serves comes from `WORKER_DOMAINS`: production
 * runs one process per domain, on-premise runs all six in one. That is
 * configuration, not a code path — there is no `if (onPremise)` here.
 *
 * Three things this file is responsible for, and nothing else:
 *
 *  - **Tenant binding (ER-043).** A handler is invoked inside
 *    `uow.withTenant(payload.companyId, …)` — the same helper the API uses,
 *    with the same transaction discipline (ER-018). A handler receives a
 *    `TxScope` and cannot obtain one any other way, so there is no
 *    worker-specific shortcut to take.
 *
 *  - **Policy application (ER-044).** Concurrency comes from the domain
 *    policy; retry limit, backoff, timeout and dead-letter destination are
 *    declared on the queue itself in `createQueues`, so they hold for every
 *    job in the domain rather than being restated per handler.
 *
 *  - **Dispatch.** Envelope in, registered handler out.
 *
 * Concurrency is **fixed per domain**. Tenant fairness — the per-tenant
 * in-flight cap — is deferred to T-159a and will land entirely inside
 * `platform/queue` (ER-044a, D-040). Nothing here will need to change for it,
 * which is the point of routing through `queueNamesFor` rather than assuming
 * a domain is a queue.
 */

/** Everything a handler is given. Ids only — the payload is not an entity. */
export interface JobContext<P extends TenantJobPayload = TenantJobPayload> {
  /** Already bound to `payload.companyId`. Every read and write goes here. */
  readonly tx: TxScope;
  readonly payload: P;
  readonly jobId: string;
  /**
   * 0 on first delivery. Delivery is at-least-once and handlers are idempotent
   * (ER-041), so this is for logging and for deciding to give up early — never
   * for changing what the handler writes.
   */
  readonly attempt: number;
}

export type JobHandler<P extends TenantJobPayload = TenantJobPayload> = (
  context: JobContext<P>,
) => Promise<void>;

/**
 * Job name → handler, for one domain.
 *
 * A job belongs to exactly one domain (ER-041a), which `buildRegistry`
 * enforces rather than trusting: the same name in two domains means one of the
 * two registrations is silently dead.
 */
export type DomainHandlers = Readonly<Record<string, JobHandler>>;
export type WorkerRegistry = Readonly<Partial<Record<QueueDomain, DomainHandlers>>>;

export class JobRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobRegistrationError';
  }
}

export class UnknownJobError extends Error {
  constructor(domain: QueueDomain, jobName: string) {
    super(
      `no handler registered for job "${jobName}" in domain "${domain}". ` +
        'It will retry and then dead-letter. Either register it or stop enqueueing it.',
    );
    this.name = 'UnknownJobError';
  }
}

/**
 * Validates a registry once, at startup, so a duplicate or misplaced job name
 * fails the boot rather than surfacing as jobs that quietly never run.
 */
export function buildRegistry(registry: WorkerRegistry): WorkerRegistry {
  const seen = new Map<string, QueueDomain>();
  for (const domain of QUEUE_DOMAINS) {
    for (const jobName of Object.keys(registry[domain] ?? {})) {
      const existing = seen.get(jobName);
      if (existing !== undefined) {
        throw new JobRegistrationError(
          `job "${jobName}" is registered in both "${existing}" and "${domain}". ` +
            'A job belongs to exactly one domain (ER-041a).',
        );
      }
      seen.set(jobName, domain);
    }
  }
  return registry;
}

export interface WorkerOptions {
  readonly boss: PgBoss;
  readonly uow: UnitOfWorkPort;
  readonly config: Config;
  readonly registry: WorkerRegistry;
  /** Called when a job throws, after pg-boss has been told it failed. */
  readonly onJobError?: (domain: QueueDomain, jobName: string, error: unknown) => void;
}

export interface WorkerFleet {
  /** The domains this process actually serves. */
  readonly domains: readonly QueueDomain[];
  stop(): Promise<void>;
}

function readEnvelope(data: unknown): JobEnvelope {
  const envelope = data as Partial<JobEnvelope> | null;
  const jobName = envelope?.jobName;
  const payload = envelope?.payload;
  if (typeof jobName !== 'string' || payload === undefined) {
    throw new Error('job data is not a JobEnvelope — it was not enqueued through QueuePort');
  }
  if (typeof payload.companyId !== 'string' || payload.companyId === '') {
    /* ER-042a. Without companyId there is no tenant to bind, and running the
       handler unbound would either see nothing or — worse — see everything. */
    throw new Error(`job "${jobName}" has no companyId in its payload (ER-042a)`);
  }
  return { jobName, payload };
}

/**
 * Runs one claimed batch. Jobs run sequentially: each holds a database
 * transaction for its duration, and fanning a batch across `concurrency`
 * connections would let a single domain drain the pool.
 */
async function runBatch(
  context: BatchContext,
  jobs: PgBoss.JobWithMetadata<unknown>[],
): Promise<void> {
  const { domain, handlers, uow, onJobError } = context;

  for (const job of jobs) {
    const { jobName, payload } = readEnvelope(job.data);
    const handler = handlers[jobName];
    if (handler === undefined) throw new UnknownJobError(domain, jobName);

    try {
      /* ER-043: the same helper the API uses. The handler's writes and the
         transaction that scopes them to one tenant are the same transaction —
         there is no window in which it runs unbound. */
      await uow.withTenant(payload.companyId, (tx) =>
        handler({ tx, payload, jobId: job.id, attempt: job.retryCount }),
      );
    } catch (error) {
      /* Rethrow so pg-boss applies the domain's retry policy and, once
         exhausted, moves the job to its dead-letter queue (ER-044). Swallowing
         here would turn a permanent failure into a silent one. */
      onJobError?.(domain, jobName, error);
      throw error;
    }
  }
}

interface BatchContext {
  readonly domain: QueueDomain;
  readonly handlers: DomainHandlers;
  readonly uow: UnitOfWorkPort;
  readonly onJobError: WorkerOptions['onJobError'];
}

/**
 * Starts one pool per served domain.
 *
 * Handlers run one job at a time within a batch rather than in parallel: each
 * holds a database transaction for its duration, and a batch fanned out across
 * `concurrency` connections would let a single domain drain the pool.
 */
export async function startWorkers(options: WorkerOptions): Promise<WorkerFleet> {
  const { boss, uow, config, registry, onJobError } = options;
  const domains = config.workerDomains;

  for (const domain of domains) {
    const policy = QUEUE_POLICIES[domain];
    const handlers = registry[domain] ?? {};

    /* A domain may be backed by more than one queue. Serving the domain means
       serving all of them, so this loops rather than assuming a single name. */
    for (const queueName of queueNamesFor(domain)) {
      await boss.work(
        queueName,
        /* `includeMetadata` is what carries `retryCount`, and therefore what
           lets a handler see it is on a redelivery (ER-041). */
        { batchSize: policy.concurrency, includeMetadata: true },
        (jobs: PgBoss.JobWithMetadata<unknown>[]) =>
          runBatch({ domain, handlers, uow, onJobError }, jobs),
      );
    }
  }

  return {
    domains,
    stop: async (): Promise<void> => {
      await boss.stop({ graceful: true });
    },
  };
}

/** Exported for the control-integrity assertion that every domain dead-letters. */
export { deadLetterQueue };
