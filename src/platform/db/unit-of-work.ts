import { sql, type SQL } from 'drizzle-orm';

import type { UnitOfWorkPort, TxScope } from '../../shared/ports/unit-of-work.js';
import type { CompanyId } from '../../shared/types/ids.js';

import { createDatabase, type AppDatabase, type DatabaseOptions, type TxClient } from './client.js';
import { createTxScope, revokeTxScope } from './tx-scope.js';

/**
 * The `UnitOfWorkPort` implementation (D-044, ER-018, SEC-004).
 *
 * Tenant binding happens exactly here, once per transaction, and nowhere else
 * in the codebase.
 */

/** The GUC every tenant RLS policy reads. Never built from a variable. */
const TENANT_SETTING = 'app.current_company_id';

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Binds tenant context for the remainder of the transaction.
 *
 * `set_config` is called with the value as a **bind parameter** — the setting
 * name is a literal in the template, so nothing is ever interpolated into SQL
 * (ER-031, SEC-042, AGENTS.md §3.2). The third argument `true` is `is_local`:
 * the setting reverts when the transaction ends, which is what makes PgBouncer
 * transaction mode safe (05a §2) and what stops the binding outliving the
 * request on a pooled connection.
 *
 * `set_config` returns the value it set, so verifying the bind took effect
 * costs no extra round trip.
 */
export function tenantBindingStatement(companyId: CompanyId): SQL {
  return sql`select set_config(${TENANT_SETTING}, ${companyId}, true) as bound`;
}

async function bindTenant(tx: TxClient, companyId: CompanyId): Promise<void> {
  const result = await tx.execute<{ bound: string | null }>(tenantBindingStatement(companyId));
  const bound = result.rows[0]?.bound;
  if (bound !== companyId) {
    throw new TenantContextError('tenant context did not take effect on this connection');
  }
}

/**
 * Asserts no tenant context is bound.
 *
 * Only reachable from `withoutTenant`, which is rare (signup, platform
 * operations), so the extra round trip is free. It turns any stray `SET`
 * without `LOCAL` anywhere in the system into a loud failure at the one place
 * that would otherwise silently inherit it.
 */
async function assertNoTenantBound(tx: TxClient): Promise<void> {
  const result = await tx.execute<{ current: string | null }>(
    sql`select current_setting(${TENANT_SETTING}, true) as current`,
  );
  const current = result.rows[0]?.current;
  if (current !== null && current !== undefined && current !== '') {
    throw new TenantContextError(
      'a tenant context was already bound on this connection before an untenanted transaction — ' +
        'something bound it outside the Unit of Work, or used SET without LOCAL',
    );
  }
}

export interface UnitOfWorkHandle {
  readonly uow: UnitOfWorkPort;
  close(): Promise<void>;
}

/**
 * The only way to obtain a Unit of Work — and therefore the only way anything
 * outside `platform/db` reaches the database at all.
 *
 * `client.ts` is behind the entry-point restriction (D-044), so bootstrap and
 * the test harness compose through here rather than building a pool and a
 * `DrizzleUnitOfWork` separately. That keeps the restriction absolute instead
 * of carving out an exemption for the composition root.
 */
export function createUnitOfWork(options: DatabaseOptions): UnitOfWorkHandle {
  const handle = createDatabase(options);
  return {
    uow: new DrizzleUnitOfWork(handle.db),
    close: handle.close.bind(handle),
  };
}

export class DrizzleUnitOfWork implements UnitOfWorkPort {
  readonly #db: AppDatabase;

  constructor(db: AppDatabase) {
    this.#db = db;
  }

  async withTenant<T>(companyId: CompanyId, fn: (tx: TxScope) => Promise<T>): Promise<T> {
    return this.#run(fn, async (tx) => {
      await bindTenant(tx, companyId);
    });
  }

  async withoutTenant<T>(fn: (tx: TxScope) => Promise<T>): Promise<T> {
    return this.#run(fn, assertNoTenantBound);
  }

  /**
   * One transaction, one connection, one scope — revoked when `fn` settles so
   * the scope cannot outlive the connection binding it describes.
   */
  async #run<T>(
    fn: (tx: TxScope) => Promise<T>,
    prepare: (tx: TxClient) => Promise<void>,
  ): Promise<T> {
    return this.#db.transaction(async (tx) => {
      await prepare(tx);
      const scope = createTxScope(tx);
      try {
        return await fn(scope);
      } finally {
        revokeTxScope(scope);
      }
    });
  }
}
