import type { TxScope } from '../../shared/ports/unit-of-work.js';

import type { PoolClient } from 'pg';

import type { TxClient } from './client.js';

/**
 * The opaque-token registry behind `TxScope` (D-044).
 *
 * A `TxScope` handed to an application service is an inert frozen object. It is
 * **not** the transaction client wearing a type cast — that distinction buys
 * three properties a cast cannot:
 *
 *  1. There is nothing to dereference. An application service that defeats the
 *     type system with `as any` still holds an object with no methods, so
 *     ER-004a is enforced by the runtime shape and not only by the compiler.
 *  2. It can be **revoked**. When a transaction ends its scope stops working,
 *     so a scope captured in a closure and used later throws instead of
 *     silently running on a pooled connection that has since been handed to
 *     another request and rebound to another tenant.
 *  3. It cannot be forged. A hand-built `{}` cast to `TxScope` is not in the
 *     registry, so it throws rather than resolving to some ambient client.
 *
 * A `WeakMap` holds the association, so a scope that goes out of scope is
 * collected with no bookkeeping.
 */

interface ScopeEntry {
  readonly client: TxClient;
  /**
   * The same transaction, as a raw `pg` connection.
   *
   * Some adapters need `(text, values)` execution rather than a Drizzle query
   * — pg-boss's `send()` accepts a `db` executor of exactly that shape, which
   * is how a job is enqueued inside the caller's transaction through public
   * API instead of by writing to its tables directly (D-016, ER-028).
   */
  readonly connection: PoolClient;
  revoked: boolean;
}

const registry = new WeakMap<TxScope, ScopeEntry>();

export class TxScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxScopeError';
  }
}

export function createTxScope(client: TxClient, connection: PoolClient): TxScope {
  const token = Object.freeze({}) as unknown as TxScope;
  registry.set(token, { client, connection, revoked: false });
  return token;
}

/**
 * Ends a scope's validity. Called when the transaction settles, whether it
 * committed or rolled back.
 */
export function revokeTxScope(scope: TxScope): void {
  const entry = registry.get(scope);
  if (entry !== undefined) entry.revoked = true;
}

/**
 * Exchanges a scope for the transaction client it represents.
 *
 * Only repositories in `infrastructure/` call this, and only with a scope
 * their caller passed in — never one they stored.
 *
 * @throws {TxScopeError} if the scope was not issued here, or its transaction
 *   has already ended.
 */
function entryFor(scope: TxScope): ScopeEntry {
  const entry = registry.get(scope);
  if (entry === undefined) {
    throw new TxScopeError(
      'not a transaction scope issued by platform/db — a TxScope cannot be constructed, only received from UnitOfWorkPort',
    );
  }
  if (entry.revoked) {
    throw new TxScopeError(
      'this transaction has already ended — a TxScope is valid only for the duration of the callback it was passed to, ' +
        'and its connection may since have been rebound to another tenant',
    );
  }
  return entry;
}

export function unwrapTxScope(scope: TxScope): TxClient {
  return entryFor(scope).client;
}

/**
 * The raw connection behind a scope, for adapters that speak `(text, values)`.
 *
 * Same validity rules as `unwrapTxScope`: forged and expired scopes throw.
 */
export function unwrapTxConnection(scope: TxScope): PoolClient {
  return entryFor(scope).connection;
}
