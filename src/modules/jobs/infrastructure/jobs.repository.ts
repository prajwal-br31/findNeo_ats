import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

import { jobScopePredicate, type JobScope } from './job-scope.js';

/** Job persistence (T-044, T-045, T-049). */

export interface JobRow extends Record<string, unknown> {
  readonly id: string;
  readonly title: string;
  readonly departmentId: string;
  readonly status: string;
  readonly confidential: boolean;
  readonly employmentType: string | null;
  readonly workMode: string | null;
  readonly salaryMin: string | null;
  readonly salaryMax: string | null;
  readonly salaryCurrency: string | null;
  readonly publishToCareerSite: boolean;
  readonly publishedAt: Date | string | null;
  readonly formTemplateVersionId: string;
  readonly customFields: unknown;
  readonly createdAt: Date | string;
}

export interface InsertJobInput {
  readonly companyId: CompanyId;
  readonly departmentId: string;
  readonly title: string;
  readonly description: string | null;
  readonly employmentType: string | null;
  readonly workMode: string | null;
  readonly countryCode: string | null;
  readonly city: string | null;
  readonly headcount: number;
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly salaryCurrency: string | null;
  readonly formTemplateVersionId: string;
  readonly customFields: unknown;
  readonly createdBy: UserId;
}

const SELECT_COLUMNS = sql`
  j.id, j.title, j.department_id as "departmentId", j.status, j.confidential,
  j.employment_type as "employmentType", j.work_mode as "workMode",
  j.salary_min as "salaryMin", j.salary_max as "salaryMax",
  j.salary_currency as "salaryCurrency",
  j.publish_to_career_site as "publishToCareerSite",
  j.published_at as "publishedAt",
  j.form_template_version_id as "formTemplateVersionId",
  j.custom_fields as "customFields", j.created_at as "createdAt"
`;

export class JobsRepository {
  /**
   * Lists jobs the caller may see.
   *
   * The scope predicate is composed **into the query** (SEC-022) alongside an
   * explicit company filter on top of RLS (ER-020). Filtering after the fetch
   * would return short pages and a wrong count, and would mean the rows were
   * read before being discarded.
   */
  async list(tx: TxScope, companyId: CompanyId, scope: JobScope): Promise<JobRow[]> {
    const result = await unwrapTxScope(tx).execute<JobRow>(sql`
      select ${SELECT_COLUMNS}
        from jobs j
       where j.company_id = ${companyId}
         and ${jobScopePredicate(scope)}
       order by j.created_at desc
       limit 100
    `);
    return result.rows;
  }

  /**
   * One job, subject to the same predicate.
   *
   * `undefined` covers "no such job", "another tenant's", and "confidential
   * and you may not see it" — all of which are 404 (BR-002). A 403 on the
   * last would confirm the job exists.
   */
  async findById(
    tx: TxScope,
    companyId: CompanyId,
    scope: JobScope,
    id: string,
  ): Promise<JobRow | undefined> {
    const result = await unwrapTxScope(tx).execute<JobRow>(sql`
      select ${SELECT_COLUMNS}
        from jobs j
       where j.company_id = ${companyId} and j.id = ${id}
         and ${jobScopePredicate(scope)}
    `);
    return result.rows[0];
  }

  /** Unscoped by permission — for writes, where the caller already resolved. */
  async findByIdUnscoped(tx: TxScope, id: string): Promise<JobRow | undefined> {
    const result = await unwrapTxScope(tx).execute<JobRow>(sql`
      select ${SELECT_COLUMNS} from jobs j where j.id = ${id}
    `);
    return result.rows[0];
  }

  async insert(tx: TxScope, input: InsertJobInput): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into jobs (company_id, department_id, title, description, status,
                        employment_type, work_mode, country_code, city, headcount,
                        salary_min, salary_max, salary_currency,
                        form_template_version_id, custom_fields, created_by)
      values (${input.companyId}, ${input.departmentId}, ${input.title}, ${input.description},
              'draft', ${input.employmentType}, ${input.workMode}, ${input.countryCode},
              ${input.city}, ${input.headcount}, ${input.salaryMin}, ${input.salaryMax},
              ${input.salaryCurrency}, ${input.formTemplateVersionId},
              ${JSON.stringify(input.customFields ?? {})}::jsonb, ${input.createdBy})
      returning id
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('job insert returned no row');
    return row;
  }

  async updateFields(
    tx: TxScope,
    id: string,
    patch: { title?: string; description?: string | null; customFields?: unknown },
  ): Promise<void> {
    const client = unwrapTxScope(tx);
    if (patch.title !== undefined) {
      await client.execute(sql`update jobs set title = ${patch.title} where id = ${id}`);
    }
    if (patch.description !== undefined) {
      await client.execute(
        sql`update jobs set description = ${patch.description} where id = ${id}`,
      );
    }
    if (patch.customFields !== undefined) {
      await client.execute(sql`
        update jobs set custom_fields = ${JSON.stringify(patch.customFields)}::jsonb
         where id = ${id}
      `);
    }
  }

  /** Publish is idempotent: an already-open job is a no-op, not an error. */
  async markPublished(tx: TxScope, id: string): Promise<void> {
    await unwrapTxScope(tx).execute(sql`
      update jobs set status = 'open', published_at = coalesce(published_at, now())
       where id = ${id} and status in ('draft','on_hold')
    `);
  }

  async setStatus(tx: TxScope, id: string, status: string): Promise<void> {
    await unwrapTxScope(tx).execute(sql`update jobs set status = ${status} where id = ${id}`);
  }

  /**
   * Sets `confidential`, and on the way *in* also withdraws the job publicly.
   *
   * One statement so the two can never disagree. Clearing the flag does NOT
   * republish (BR-033): reappearing on a public careers page must never be a
   * side effect of clearing a private flag.
   */
  async setConfidential(tx: TxScope, id: string, confidential: boolean): Promise<void> {
    if (confidential) {
      await unwrapTxScope(tx).execute(sql`
        update jobs
           set confidential = true, publish_to_career_site = false, published_at = null
         where id = ${id}
      `);
      return;
    }

    await unwrapTxScope(tx).execute(sql`
      update jobs set confidential = false where id = ${id}
    `);
  }

  async delete(tx: TxScope, id: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      delete from jobs where id = ${id} and status = 'draft'
    `);
    return result.rowCount ?? 0;
  }
}
