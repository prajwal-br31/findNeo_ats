import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

/**
 * Talent pool persistence (T-063).
 *
 * **The tenant column here is `owner_company_id`**, not `company_id` — the one
 * naming deviation in the schema (06b §1). Every statement in this file that
 * names it is doing so deliberately; RLS is enforcing the same rule it does
 * everywhere else, just through a differently-named column.
 */

export interface PoolEntryRow extends Record<string, unknown> {
  readonly id: string;
  readonly candidateId: string;
  readonly fullName: string;
  readonly status: string;
  readonly source: string | null;
  readonly notes: string | null;
  readonly tags: string[];
  readonly createdAt: Date | string;
}

export interface AddToPoolInput {
  readonly ownerCompanyId: CompanyId;
  readonly candidateId: string;
  readonly source: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
  readonly addedBy: UserId;
}

/**
 * A `text[]` literal built from one bind per element.
 *
 * **Not `${array}::text[]`.** Drizzle passes a JS array through as a single
 * parameter and the driver renders it JSON-style — `["a","b"]` — which
 * Postgres rejects as a malformed array literal (22P02). It wants `{a,b}`.
 *
 * The second occurrence of this mistake: it was fixed once for `= any(...)`
 * in `roles.repository.ts` and reintroduced here. The fix is always the same
 * shape — one placeholder per element, `ARRAY[...]` builds the value — so it
 * lives in a named function now rather than being open-coded a third time.
 */
function textArray(values: readonly string[]): ReturnType<typeof sql> {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

export class PoolRepository {
  /**
   * One page of pool entries, joined to the candidate for a display name.
   *
   * The join is safe across the naming deviation because the composite FK
   * ties `(candidate_id, owner_company_id)` to `(candidates.id, company_id)`
   * — a pool entry cannot name a candidate from another tenant, and RLS on
   * both tables is checked independently anyway.
   */
  async list(tx: TxScope, status: string | undefined, limit: number): Promise<PoolEntryRow[]> {
    const client = unwrapTxScope(tx);
    const columns = sql`
      p.id, p.candidate_id as "candidateId", c.full_name as "fullName",
      p.status, p.source, p.notes, p.tags, p.created_at as "createdAt"
    `;

    if (status === undefined) {
      const result = await client.execute<PoolEntryRow>(sql`
        select ${columns}
          from talent_pool_entries p
          join candidates c on c.id = p.candidate_id
         order by p.created_at desc
         limit ${limit}
      `);
      return result.rows;
    }

    const result = await client.execute<PoolEntryRow>(sql`
      select ${columns}
        from talent_pool_entries p
        join candidates c on c.id = p.candidate_id
       where p.status = ${status}
       order by p.created_at desc
       limit ${limit}
    `);
    return result.rows;
  }

  /**
   * Idempotent by design: a candidate is in a pool or is not, and adding them
   * twice is not an error worth surfacing to a recruiter. `DO UPDATE` rather
   * than `DO NOTHING` so a re-add revives an archived entry, which is what
   * the action means.
   */
  async add(tx: TxScope, input: AddToPoolInput): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into talent_pool_entries
        (owner_company_id, candidate_id, source, notes, tags, added_by)
      values (
        ${input.ownerCompanyId}, ${input.candidateId}, ${input.source},
        ${input.notes}, ${textArray(input.tags)}, ${input.addedBy}
      )
      on conflict (owner_company_id, candidate_id) do update
        set status = 'active',
            notes  = coalesce(excluded.notes, talent_pool_entries.notes),
            tags   = excluded.tags,
            updated_at = now()
      returning id
    `);

    const row = result.rows[0];
    if (row === undefined) throw new Error('pool insert returned no row');
    return row;
  }

  async setStatus(tx: TxScope, id: string, status: string): Promise<boolean> {
    const result = await unwrapTxScope(tx).execute(sql`
      update talent_pool_entries set status = ${status} where id = ${id}
    `);
    return (result.rowCount ?? 0) > 0;
  }

  async remove(tx: TxScope, id: string): Promise<boolean> {
    const result = await unwrapTxScope(tx).execute(sql`
      delete from talent_pool_entries where id = ${id}
    `);
    return (result.rowCount ?? 0) > 0;
  }
}
