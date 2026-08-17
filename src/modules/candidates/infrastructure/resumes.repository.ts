import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

/** Resume persistence (T-064, T-065). */

export interface ResumeRow extends Record<string, unknown> {
  readonly id: string;
  readonly candidateId: string;
  readonly applicationId: string | null;
  readonly storageKey: string;
  readonly originalFilename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly isCurrent: boolean;
  readonly createdAt: Date | string;
}

export interface InsertResumeInput {
  readonly companyId: CompanyId;
  readonly candidateId: string;
  readonly applicationId: string | null;
  readonly storageKey: string;
  readonly originalFilename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly uploadedBy: UserId | null;
  readonly isCurrent: boolean;
}

const COLUMNS = sql`
  r.id, r.candidate_id as "candidateId", r.application_id as "applicationId",
  r.storage_key as "storageKey", r.original_filename as "originalFilename",
  r.content_type as "contentType", r.size_bytes as "sizeBytes",
  r.checksum_sha256 as "checksumSha256", r.is_current as "isCurrent",
  r.created_at as "createdAt"
`;

export class ResumesRepository {
  /** Any resume row, profile-level or frozen. `applicationId` says which. */
  async findById(tx: TxScope, id: string): Promise<ResumeRow | undefined> {
    const result = await unwrapTxScope(tx).execute<ResumeRow>(sql`
      select ${COLUMNS} from candidate_resumes r where r.id = ${id}
    `);
    return result.rows[0];
  }

  /** The profile-level current resume, if the candidate has one. */
  async findCurrentForCandidate(tx: TxScope, candidateId: string): Promise<ResumeRow | undefined> {
    const result = await unwrapTxScope(tx).execute<ResumeRow>(sql`
      select ${COLUMNS} from candidate_resumes r
       where r.candidate_id = ${candidateId}
         and r.application_id is null and r.is_current
    `);
    return result.rows[0];
  }

  async findForApplication(tx: TxScope, applicationId: string): Promise<ResumeRow | undefined> {
    const result = await unwrapTxScope(tx).execute<ResumeRow>(sql`
      select ${COLUMNS} from candidate_resumes r where r.application_id = ${applicationId}
    `);
    return result.rows[0];
  }

  async listForCandidate(tx: TxScope, candidateId: string): Promise<ResumeRow[]> {
    const result = await unwrapTxScope(tx).execute<ResumeRow>(sql`
      select ${COLUMNS} from candidate_resumes r
       where r.candidate_id = ${candidateId}
       order by r.created_at desc
    `);
    return result.rows;
  }

  /**
   * Demotes the previous profile resume.
   *
   * `ux_resume_current_profile` permits exactly one `is_current` row per
   * candidate at profile level, so this must run before the insert or the
   * insert violates it. Same transaction, always — a demote that commits
   * without its promote leaves a candidate with no current resume.
   */
  async clearCurrent(tx: TxScope, candidateId: string): Promise<void> {
    await unwrapTxScope(tx).execute(sql`
      update candidate_resumes set is_current = false
       where candidate_id = ${candidateId}
         and application_id is null and is_current
    `);
  }

  async insert(tx: TxScope, input: InsertResumeInput): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into candidate_resumes (
        company_id, candidate_id, application_id, storage_key, original_filename,
        content_type, size_bytes, checksum_sha256, uploaded_by, is_current
      ) values (
        ${input.companyId}, ${input.candidateId}, ${input.applicationId},
        ${input.storageKey}, ${input.originalFilename}, ${input.contentType},
        ${input.sizeBytes}, ${input.checksumSha256}, ${input.uploadedBy}, ${input.isCurrent}
      )
      returning id
    `);

    const row = result.rows[0];
    if (row === undefined) throw new Error('resume insert returned no row');
    return row;
  }

  /**
   * Mints an id before the row exists, so the storage key can contain it.
   *
   * The alternative is inserting with a placeholder key and updating after
   * the upload, which leaves a row pointing at nothing if the upload fails.
   */
  async nextId(tx: TxScope): Promise<string> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`select uuidv7() as id`);
    const row = result.rows[0];
    if (row === undefined) throw new Error('uuidv7() returned no row');
    return row.id;
  }
}
