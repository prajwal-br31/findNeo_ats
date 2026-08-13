import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

/**
 * The connection pool and Drizzle instance.
 *
 * Not importable outside `platform/db` — the `boundaries/entry-point`
 * restriction (D-044) exposes only `unit-of-work.ts` and `tx-scope.ts`, so no
 * repository can obtain an unbound client and run a query outside a
 * tenant-scoped transaction.
 */

export type AppDatabase = NodePgDatabase;

/**
 * The client Drizzle hands to a `transaction()` callback. Derived from the
 * signature rather than named directly, so it cannot drift from the version
 * of Drizzle actually installed.
 */
export type TxClient = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

export interface DatabaseHandle {
  readonly db: AppDatabase;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly url: string;
  readonly poolMax: number;
  /** Shows up in `pg_stat_activity`; makes a stuck connection attributable. */
  readonly applicationName: string;
}

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new Pool({
    connectionString: options.url,
    max: options.poolMax,
    application_name: options.applicationName,
  });

  return {
    db: drizzle(pool),
    close: async (): Promise<void> => {
      await pool.end();
    },
  };
}
