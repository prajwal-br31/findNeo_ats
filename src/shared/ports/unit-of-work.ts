import type { CompanyId } from '../types/ids.js';

/**
 * D-044 / ER-004a — the Unit of Work port.
 *
 * Resolves the tension between ER-003 (application services own transaction
 * boundaries) and ER-006 (no database access outside a repository): a service
 * can say "run these repository calls in one transaction with tenant context
 * bound" without importing the ORM.
 *
 * ```ts
 * await this.uow.withTenant(ctx.companyId, async (tx) => {
 *   const job = await this.jobRepo.create(tx, input);
 *   await this.outboxRepo.write(tx, 'job.created', { jobId: job.id });
 * });
 * ```
 *
 * `platform/db` is the only code that knows what a `TxScope` actually is.
 */

/**
 * An opaque handle to an open transaction with tenant context already bound.
 *
 * Deliberately carries no members. An application service receives one, passes
 * it to repositories, and **never dereferences it** (ER-004a) — there is
 * nothing on it to dereference. Repositories in `infrastructure/` exchange it
 * for a real client through `platform/db`.
 *
 * The brand is nominal only. The runtime value is an inert token; holding one
 * grants no capability by itself, and it stops working the moment its
 * transaction ends.
 */
declare const txScopeBrand: unique symbol;

export type TxScope = { readonly [txScopeBrand]: 'TxScope' };

export interface UnitOfWorkPort {
  /**
   * Opens one transaction, binds `app.current_company_id` to `companyId` for
   * its duration (ER-018), and runs `fn`. Commits on return, rolls back on
   * throw. The scope is revoked when `fn` settles.
   */
  withTenant<T>(companyId: CompanyId, fn: (tx: TxScope) => Promise<T>): Promise<T>;

  /**
   * Opens one transaction with **no** tenant context bound.
   *
   * For the operations that legitimately precede tenancy — signup creates a
   * company before any company id exists — and for platform-admin work, which
   * is never ambient tenant access (SEC-026).
   *
   * Every tenant-scoped table is invisible inside this scope: unset context
   * matches no RLS policy and yields zero rows (SEC-003). That is the intended
   * behaviour, not a limitation to work around.
   */
  withoutTenant<T>(fn: (tx: TxScope) => Promise<T>): Promise<T>;
}
