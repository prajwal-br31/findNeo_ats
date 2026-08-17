import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

/** Application persistence (T-065 through T-069). */

export interface ApplicationRow extends Record<string, unknown> {
  readonly id: string;
  readonly jobId: string;
  readonly jobTitle: string | null;
  readonly candidateId: string;
  readonly currentStageId: string | null;
  readonly currentStageName: string | null;
  readonly status: string;
  readonly source: string;
  readonly ownerUserId: string | null;
  readonly formTemplateVersionId: string;
  readonly customFields: unknown;
  readonly appliedAt: Date | string;
  readonly closedAt: Date | string | null;
  readonly transferredFromId: string | null;
  readonly snapshotFullName: string;
  readonly snapshotEmail: string | null;
  readonly snapshotPhone: string | null;
  readonly snapshotCurrentTitle: string | null;
  readonly snapshotCurrentEmployer: string | null;
  readonly snapshotExperienceYears: string | null;
  readonly snapshotCurrentCtc: string | null;
  readonly snapshotExpectedCtc: string | null;
  readonly snapshotNoticePeriodDays: number | null;
  readonly snapshotCtcCurrency: string | null;
  readonly snapshotLocation: string | null;
  readonly snapshotEducationLevel: string | null;
}

/**
 * The snapshot, assembled by the service from the candidate profile plus what
 * the applicant typed. Passed as one object because these fields are written
 * once, together, and never again (BR-056).
 */
export interface ApplicationSnapshot {
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly currentTitle: string | null;
  readonly currentEmployer: string | null;
  readonly experienceYears: number | null;
  readonly currentCtc: number | null;
  readonly expectedCtc: number | null;
  readonly noticePeriodDays: number | null;
  readonly ctcCurrency: string | null;
  readonly location: string | null;
  readonly educationLevel: string | null;
}

export interface InsertApplicationInput {
  readonly companyId: CompanyId;
  readonly jobId: string;
  readonly candidateId: string;
  readonly currentStageId: string | null;
  readonly source: string;
  readonly ownerUserId: UserId | null;
  readonly formTemplateVersionId: string;
  readonly customFields: unknown;
  readonly transferredFromId: string | null;
  readonly snapshot: ApplicationSnapshot;
}

const COLUMNS = sql`
  a.id, a.job_id as "jobId", j.title as "jobTitle", a.candidate_id as "candidateId",
  a.current_stage_id as "currentStageId", s.name as "currentStageName",
  a.status, a.source, a.owner_user_id as "ownerUserId",
  a.form_template_version_id as "formTemplateVersionId",
  a.custom_fields as "customFields",
  a.applied_at as "appliedAt", a.closed_at as "closedAt",
  a.transferred_from_id as "transferredFromId",
  a.snapshot_full_name as "snapshotFullName", a.snapshot_email as "snapshotEmail",
  a.snapshot_phone as "snapshotPhone",
  a.snapshot_current_title as "snapshotCurrentTitle",
  a.snapshot_current_employer as "snapshotCurrentEmployer",
  a.snapshot_experience_years as "snapshotExperienceYears",
  a.snapshot_current_ctc as "snapshotCurrentCtc",
  a.snapshot_expected_ctc as "snapshotExpectedCtc",
  a.snapshot_notice_period_days as "snapshotNoticePeriodDays",
  a.snapshot_ctc_currency as "snapshotCtcCurrency",
  a.snapshot_location as "snapshotLocation",
  a.snapshot_education_level as "snapshotEducationLevel"
`;

const FROM = sql`
  from applications a
  join jobs j on j.id = a.job_id
  left join job_pipeline_stages s on s.id = a.current_stage_id
`;

export class ApplicationsRepository {
  async listForJob(tx: TxScope, jobId: string, limit: number): Promise<ApplicationRow[]> {
    const result = await unwrapTxScope(tx).execute<ApplicationRow>(sql`
      select ${COLUMNS} ${FROM}
       where a.job_id = ${jobId}
       order by a.applied_at desc
       limit ${limit}
    `);
    return result.rows;
  }

  async listForCandidate(
    tx: TxScope,
    candidateId: string,
    limit: number,
  ): Promise<ApplicationRow[]> {
    const result = await unwrapTxScope(tx).execute<ApplicationRow>(sql`
      select ${COLUMNS} ${FROM}
       where a.candidate_id = ${candidateId}
       order by a.applied_at desc
       limit ${limit}
    `);
    return result.rows;
  }

  async findById(tx: TxScope, id: string): Promise<ApplicationRow | undefined> {
    const result = await unwrapTxScope(tx).execute<ApplicationRow>(sql`
      select ${COLUMNS} ${FROM} where a.id = ${id}
    `);
    return result.rows[0];
  }

  /**
   * Inserts the application and its frozen snapshot.
   *
   * **The cap is not checked here.** `trg_application_cap` takes a row lock on
   * the candidate and does it inside the insert (BR-057, BR-058). A pre-check
   * in this method would be a check-then-act race and would also be the thing
   * a reader trusted instead of the trigger.
   */
  async insert(tx: TxScope, input: InsertApplicationInput): Promise<{ id: string }> {
    const s = input.snapshot;
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into applications (
        company_id, job_id, candidate_id, current_stage_id, source, owner_user_id,
        form_template_version_id, custom_fields, transferred_from_id,
        snapshot_full_name, snapshot_email, snapshot_phone,
        snapshot_current_title, snapshot_current_employer, snapshot_experience_years,
        snapshot_current_ctc, snapshot_expected_ctc, snapshot_notice_period_days,
        snapshot_ctc_currency, snapshot_location, snapshot_education_level
      ) values (
        ${input.companyId}, ${input.jobId}, ${input.candidateId}, ${input.currentStageId},
        ${input.source}, ${input.ownerUserId}, ${input.formTemplateVersionId},
        ${JSON.stringify(input.customFields ?? {})}::jsonb, ${input.transferredFromId},
        ${s.fullName}, ${s.email}, ${s.phone}, ${s.currentTitle}, ${s.currentEmployer},
        ${s.experienceYears}, ${s.currentCtc}, ${s.expectedCtc}, ${s.noticePeriodDays},
        ${s.ctcCurrency}, ${s.location}, ${s.educationLevel}
      )
      returning id
    `);

    const row = result.rows[0];
    if (row === undefined) throw new Error('application insert returned no row');
    return row;
  }

  /** Moves the application to a stage. The caller has already validated it. */
  async setStage(tx: TxScope, id: string, stageId: string): Promise<void> {
    await unwrapTxScope(tx).execute(sql`
      update applications set current_stage_id = ${stageId} where id = ${id}
    `);
  }

  /**
   * Closes an application. `closed_at` is set for every terminal status so
   * "when did this end" has one answer regardless of how it ended.
   */
  async setStatus(tx: TxScope, id: string, status: string): Promise<boolean> {
    const result = await unwrapTxScope(tx).execute(sql`
      update applications
         set status = ${status},
             closed_at = case when ${status} = 'active' then null else now() end
       where id = ${id}
    `);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * The job's pinned form-template version.
   *
   * An application is created under the same version its job was, so a
   * template edited afterwards never changes how a submitted application
   * renders (BR-046 applied to applications).
   */
  async jobFormVersion(
    tx: TxScope,
    jobId: string,
  ): Promise<{ formTemplateVersionId: string } | undefined> {
    const result = await unwrapTxScope(tx).execute<{ formTemplateVersionId: string }>(sql`
      select form_template_version_id as "formTemplateVersionId"
        from jobs where id = ${jobId}
    `);
    return result.rows[0];
  }

  async countActiveForCandidate(tx: TxScope, candidateId: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute<{ count: string }>(sql`
      select count(*) as count from applications
       where candidate_id = ${candidateId} and status = 'active'
    `);
    return Number(result.rows[0]?.count ?? 0);
  }
}
