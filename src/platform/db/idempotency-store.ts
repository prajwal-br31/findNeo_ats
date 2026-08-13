import { sql } from 'drizzle-orm';

import type {
  IdempotencyRecord,
  IdempotencyStorePort,
  ReservationInput,
  ReserveResult,
} from '../../shared/ports/idempotency-store.js';
import type { TxScope } from '../../shared/ports/unit-of-work.js';

import { unwrapTxScope } from './tx-scope.js';

/**
 * `IdempotencyStorePort` over `idempotency_keys` (06 §7, migration 001b).
 */

interface Row extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
  readonly request_hash: string;
  readonly response_status: number | null;
  readonly response_body: unknown;
}

function toRecord(row: Row): IdempotencyRecord {
  return {
    id: row.id,
    status: row.status === 'completed' ? 'completed' : 'in_flight',
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    responseBody: row.response_body,
  };
}

export class DrizzleIdempotencyStore implements IdempotencyStorePort {
  /**
   * One statement claims the key or reports nothing, and a second reads the
   * incumbent. `ON CONFLICT DO NOTHING` rather than a read-then-write, because
   * check-then-act races (ER-030) and the whole point of this table is to be
   * correct when two requests arrive together.
   */
  async reserve(tx: TxScope, input: ReservationInput): Promise<ReserveResult> {
    const client = unwrapTxScope(tx);

    const inserted = await client.execute<{ id: string }>(sql`
      insert into idempotency_keys (company_id, key, endpoint, request_hash, status, expires_at)
      values (${input.companyId}, ${input.key}, ${input.endpoint}, ${input.requestHash},
              'in_flight', ${input.expiresAt.toISOString()})
      on conflict (company_id, endpoint, key) do nothing
      returning id
    `);

    const id = inserted.rows[0]?.id;
    if (id !== undefined) return { outcome: 'reserved', id };

    const existing = await client.execute<Row>(sql`
      select id, status, request_hash, response_status, response_body
        from idempotency_keys
       where endpoint = ${input.endpoint}
         and key = ${input.key}
         and company_id is not distinct from ${input.companyId}
    `);

    const row = existing.rows[0];
    if (row === undefined) {
      /* The incumbent vanished between the two statements — a concurrent
         release, or the reaper. Treat it as ours to claim; the caller retries
         and the unique index adjudicates again. */
      return this.reserve(tx, input);
    }
    return { outcome: 'exists', record: toRecord(row) };
  }

  async complete(
    tx: TxScope,
    id: string,
    responseStatus: number,
    responseBody: unknown,
  ): Promise<void> {
    await unwrapTxScope(tx).execute(sql`
      update idempotency_keys
         set status = 'completed',
             response_status = ${responseStatus},
             response_body = ${JSON.stringify(responseBody ?? null)}::jsonb
       where id = ${id}
    `);
  }

  async release(tx: TxScope, id: string): Promise<void> {
    await unwrapTxScope(tx).execute(sql`delete from idempotency_keys where id = ${id}`);
  }
}
