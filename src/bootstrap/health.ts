import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AppMetrics } from '../platform/telemetry/metrics.js';
import type { TxScope, UnitOfWorkPort } from '../shared/ports/unit-of-work.js';
import { unwrapTxScope } from '../platform/db/tx-scope.js';

/**
 * Health and metrics (12 §3, §4), on the loopback listener only.
 *
 * **These endpoints expose no version, hostname, dependency name, or internal
 * detail** (12 §4, SEC-066). They are unauthenticated and a standard
 * reconnaissance target, so the body is a status and nothing else — the reason
 * a check failed goes to the log, where an operator with access can read it.
 *
 * | Endpoint          | Answers                                   |
 * |-------------------|-------------------------------------------|
 * | `/health/live`    | the process is up                         |
 * | `/health/ready`   | it can serve traffic — database reachable |
 * | `/health/startup` | migrations have been applied              |
 */

export interface HealthDependencies {
  readonly uow: UnitOfWorkPort;
  readonly metrics: AppMetrics;
  /** Logged, never returned: a failure reason is internal detail. */
  readonly onCheckFailed?: (check: string, error: unknown) => void;
}

async function databaseReachable(uow: UnitOfWorkPort): Promise<boolean> {
  await uow.withoutTenant(async (tx: TxScope) => unwrapTxScope(tx).execute(sql`select 1`));
  return true;
}

/**
 * Migrations applied, per 12 §4. Reads the migration table drizzle maintains;
 * an empty or absent table means the database has not been prepared.
 */
async function migrationsApplied(uow: UnitOfWorkPort): Promise<boolean> {
  const applied = await uow.withoutTenant(async (tx: TxScope) =>
    unwrapTxScope(tx).execute<{ n: string }>(
      sql`select count(*)::text as n from drizzle.__drizzle_migrations`,
    ),
  );
  return Number.parseInt(applied.rows[0]?.n ?? '0', 10) > 0;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDependencies): void {
  app.get('/health/live', () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await databaseReachable(deps.uow);
      return { status: 'ok' };
    } catch (error) {
      deps.onCheckFailed?.('ready', error);
      // Status only. Which dependency failed, and why, stays internal.
      return await reply.status(503).send({ status: 'unavailable' });
    }
  });

  app.get('/health/startup', async (_request, reply) => {
    try {
      if (await migrationsApplied(deps.uow)) return { status: 'ok' };
      deps.onCheckFailed?.('startup', new Error('no migrations applied'));
      return await reply.status(503).send({ status: 'unavailable' });
    } catch (error) {
      deps.onCheckFailed?.('startup', error);
      return await reply.status(503).send({ status: 'unavailable' });
    }
  });

  app.get('/metrics', async (_request, reply) => {
    const body = await deps.metrics.registry.metrics();
    return await reply.type(deps.metrics.registry.contentType).send(body);
  });
}
