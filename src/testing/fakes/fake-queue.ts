import type {
  EnqueuedJob,
  QueueDomain,
  QueuePort,
  TenantJobPayload,
} from '../../shared/ports/queue.js';
import type { TxScope, UnitOfWorkPort } from '../../shared/ports/unit-of-work.js';
import type { CompanyId } from '../../shared/types/ids.js';

/**
 * `QueuePort` fake that respects transaction outcome (11 §7).
 *
 * The obvious fake records the enqueue immediately, and that fake **hides the
 * bug the real design exists to prevent**: with pg-boss the job is a row in
 * the same transaction as the state change, so a rollback discards it
 * (D-016, ER-028). A fake that delivers eagerly would let a service enqueue
 * outside its transaction and every test would still pass.
 *
 * So jobs are buffered against the scope that enqueued them, and only become
 * drainable once that transaction is known to have committed. The port itself
 * has no commit hook — with a real database it does not need one, because the
 * database provides the semantics — so tests drive transactions through
 * `withTransaction` here, which settles the buffer on the way out.
 */

export interface RecordedJob extends EnqueuedJob {
  readonly payload: TenantJobPayload;
}

export class FakeQueue implements QueuePort {
  readonly #pending = new Map<TxScope, RecordedJob[]>();
  readonly #committed: RecordedJob[] = [];
  #sequence = 0;

  enqueue(
    tx: TxScope,
    domain: QueueDomain,
    jobName: string,
    payload: TenantJobPayload,
  ): Promise<EnqueuedJob> {
    this.#sequence += 1;
    const job: RecordedJob = { jobId: `fake-${String(this.#sequence)}`, domain, jobName, payload };
    this.#pending.set(tx, [...(this.#pending.get(tx) ?? []), job]);
    return Promise.resolve(job);
  }

  /**
   * Runs `fn` in a real transaction and settles this queue with it: jobs
   * survive a commit and vanish on a rollback, exactly as rows do.
   */
  async withTransaction<T>(
    uow: UnitOfWorkPort,
    companyId: CompanyId | null,
    fn: (tx: TxScope) => Promise<T>,
  ): Promise<T> {
    let scope: TxScope | undefined;
    try {
      const result = await (companyId === null
        ? uow.withoutTenant(async (tx) => {
            scope = tx;
            return fn(tx);
          })
        : uow.withTenant(companyId, async (tx) => {
            scope = tx;
            return fn(tx);
          }));
      if (scope !== undefined) this.#settle(scope, true);
      return result;
    } catch (error) {
      if (scope !== undefined) this.#settle(scope, false);
      throw error;
    }
  }

  #settle(scope: TxScope, committed: boolean): void {
    const jobs = this.#pending.get(scope) ?? [];
    this.#pending.delete(scope);
    if (committed) this.#committed.push(...jobs);
  }

  /** Jobs whose transaction committed. Enqueued-then-rolled-back never appear. */
  drain(): readonly RecordedJob[] {
    const jobs = [...this.#committed];
    this.#committed.length = 0;
    return jobs;
  }

  /** Visible without consuming, for assertions that run mid-test. */
  committed(): readonly RecordedJob[] {
    return [...this.#committed];
  }

  reset(): void {
    this.#pending.clear();
    this.#committed.length = 0;
  }
}
