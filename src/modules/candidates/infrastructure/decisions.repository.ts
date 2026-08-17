import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

/** Stage decisions and the reason catalog (T-066, T-067). */

export interface DecisionRow extends Record<string, unknown> {
  readonly id: string;
  readonly applicationId: string;
  readonly fromStageId: string | null;
  readonly toStageId: string | null;
  readonly decision: string;
  readonly decidedBy: string;
  readonly decidedByName: string | null;
  readonly notes: string | null;
  readonly decidedAt: Date | string;
  readonly reasonKeys: string[];
}

export interface DecisionReasonRow extends Record<string, unknown> {
  readonly id: string;
  readonly decisionType: string;
  readonly key: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly sequenceOrder: number;
  readonly isPlatformDefault: boolean;
}

export interface InsertDecisionInput {
  readonly companyId: CompanyId;
  readonly applicationId: string;
  readonly fromStageId: string | null;
  readonly toStageId: string | null;
  readonly decision: string;
  readonly decidedBy: UserId;
  readonly notes: string | null;
}

export class DecisionsRepository {
  /**
   * The decision history for one application, newest first.
   *
   * Reasons are aggregated in the query rather than fetched per decision: a
   * history of twenty decisions is otherwise twenty-one round trips on a page
   * a recruiter opens constantly.
   */
  async listForApplication(tx: TxScope, applicationId: string): Promise<DecisionRow[]> {
    const result = await unwrapTxScope(tx).execute<DecisionRow>(sql`
      select d.id, d.application_id as "applicationId",
             d.from_stage_id as "fromStageId", d.to_stage_id as "toStageId",
             d.decision, d.decided_by as "decidedBy", u.full_name as "decidedByName",
             d.notes, d.decided_at as "decidedAt",
             coalesce((
               select array_agg(r.key order by r.sequence_order)
                 from stage_decision_reasons sdr
                 join decision_reasons r on r.id = sdr.decision_reason_id
                where sdr.stage_decision_id = d.id
             ), '{}') as "reasonKeys"
        from stage_decisions d
        left join users u on u.id = d.decided_by
       where d.application_id = ${applicationId}
       order by d.decided_at desc
    `);
    return result.rows;
  }

  async insert(tx: TxScope, input: InsertDecisionInput): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into stage_decisions (
        company_id, application_id, from_stage_id, to_stage_id, decision, decided_by, notes
      ) values (
        ${input.companyId}, ${input.applicationId}, ${input.fromStageId},
        ${input.toStageId}, ${input.decision}, ${input.decidedBy}, ${input.notes}
      )
      returning id
    `);

    const row = result.rows[0];
    if (row === undefined) throw new Error('decision insert returned no row');
    return row;
  }

  /**
   * Attaches reasons to a decision. Same transaction as the decision itself,
   * so a rejection can never commit without the reasons BR-064 demands.
   *
   * Resolves keys to ids inside the statement: the caller holds keys because
   * that is what a client sends, and a round trip per key to translate them
   * would be three queries to write one rejection.
   */
  async attachReasons(
    tx: TxScope,
    companyId: CompanyId,
    decisionId: string,
    decisionType: string,
    reasonKeys: readonly string[],
  ): Promise<number> {
    if (reasonKeys.length === 0) return 0;

    /* One bind per key. A JS array interpolated into `= any(...)` serialises
       JSON-style and Postgres rejects it (22P02). */
    const keys = sql.join(
      reasonKeys.map((key) => sql`${key}`),
      sql`, `,
    );

    const result = await unwrapTxScope(tx).execute(sql`
      insert into stage_decision_reasons (stage_decision_id, decision_reason_id, company_id)
      select ${decisionId}, r.id, ${companyId}
        from decision_reasons r
       where r.key in (${keys})
         and r.decision_type = ${decisionType}
         and r.is_active
         and (r.company_id = ${companyId} or r.company_id is null)
      on conflict do nothing
    `);
    return result.rowCount ?? 0;
  }

  /**
   * The reason catalog for a decision type: the tenant's own plus the
   * platform defaults RLS lets it read.
   */
  async listReasons(tx: TxScope, decisionType: string): Promise<DecisionReasonRow[]> {
    const result = await unwrapTxScope(tx).execute<DecisionReasonRow>(sql`
      select r.id, r.decision_type as "decisionType", r.key, r.label,
             r.is_active as "isActive", r.sequence_order as "sequenceOrder",
             (r.company_id is null) as "isPlatformDefault"
        from decision_reasons r
       where r.decision_type = ${decisionType} and r.is_active
       order by r.sequence_order, r.label
    `);
    return result.rows;
  }
}
