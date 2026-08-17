import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { CursorPayload } from '../../../shared/http/cursor.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

/** Candidate persistence (T-062, T-061's lock target). */

export interface CandidateRow extends Record<string, unknown> {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly currentTitle: string | null;
  readonly currentEmployer: string | null;
  readonly totalExperienceYears: string | null;
  readonly currentCtc: string | null;
  readonly ctcCurrency: string | null;
  readonly educationLevel: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
  readonly linkedinUrl: string | null;
  readonly source: string;
  readonly currentResumeId: string | null;
  readonly consentStatus: string;
  readonly anonymizedAt: Date | string | null;
  readonly createdAt: Date | string;
}

export interface InsertCandidateInput {
  readonly companyId: CompanyId;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly currentTitle: string | null;
  readonly currentEmployer: string | null;
  readonly totalExperienceYears: number | null;
  readonly currentCtc: number | null;
  readonly ctcCurrency: string | null;
  readonly educationLevel: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
  readonly linkedinUrl: string | null;
  readonly source: string;
  readonly createdBy: UserId;
}

export interface UpdateCandidateInput {
  readonly fullName?: string;
  readonly phone?: string | null;
  readonly currentTitle?: string | null;
  readonly currentEmployer?: string | null;
  readonly totalExperienceYears?: number | null;
  readonly currentCtc?: number | null;
  readonly ctcCurrency?: string | null;
  readonly educationLevel?: string | null;
  readonly locationCity?: string | null;
  readonly locationCountry?: string | null;
  readonly linkedinUrl?: string | null;
}

/** A possible duplicate, with how it was matched (BR-061). */
export interface DuplicateMatchRow extends Record<string, unknown> {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly matchedOn: string;
  readonly similarity: number;
}

const COLUMNS = sql`
  c.id, c.full_name as "fullName", c.email, c.phone,
  c.current_title as "currentTitle", c.current_employer as "currentEmployer",
  c.total_experience_years as "totalExperienceYears",
  c.current_ctc as "currentCtc", c.ctc_currency as "ctcCurrency",
  c.education_level as "educationLevel",
  c.location_city as "locationCity", c.location_country as "locationCountry",
  c.linkedin_url as "linkedinUrl", c.source,
  c.current_resume_id as "currentResumeId",
  c.consent_status as "consentStatus",
  c.anonymized_at as "anonymizedAt", c.created_at as "createdAt"
`;

export class CandidatesRepository {
  /**
   * One page of candidates.
   *
   * Anonymized rows are excluded: after erasure (D-034) the profile is a
   * tombstone kept for referential integrity, not a person anyone can work
   * with. Applications still reference it through their own snapshot.
   */
  async list(tx: TxScope, limit: number, after?: CursorPayload): Promise<CandidateRow[]> {
    const client = unwrapTxScope(tx);
    const fetchLimit = limit + 1;

    if (after === undefined) {
      const result = await client.execute<CandidateRow>(sql`
        select ${COLUMNS} from candidates c
         where c.anonymized_at is null
         order by c.created_at desc, c.id desc
         limit ${fetchLimit}
      `);
      return result.rows;
    }

    const result = await client.execute<CandidateRow>(sql`
      select ${COLUMNS} from candidates c
       where c.anonymized_at is null
         and (c.created_at, c.id) < (${after.sortValue}::timestamptz, ${after.id}::uuid)
       order by c.created_at desc, c.id desc
       limit ${fetchLimit}
    `);
    return result.rows;
  }

  async findById(tx: TxScope, id: string): Promise<CandidateRow | undefined> {
    const result = await unwrapTxScope(tx).execute<CandidateRow>(sql`
      select ${COLUMNS} from candidates c where c.id = ${id}
    `);
    return result.rows[0];
  }

  /**
   * Duplicate detection (BR-061). **Advisory** — this reports, it never merges.
   *
   * Two passes in one query: an exact email match, which is conclusive, and a
   * trigram name match, which is not. `matchedOn` tells the caller which it
   * was so the UI can present a certainty rather than a list of maybes.
   *
   * `similarity` is thresholded in SQL rather than in Node so the GIN index
   * on `full_name` does the work; filtering after the fetch would read the
   * whole tenant's candidates on every create.
   */
  async findPossibleDuplicates(
    tx: TxScope,
    fullName: string,
    email: string | null,
    threshold: number,
  ): Promise<DuplicateMatchRow[]> {
    const result = await unwrapTxScope(tx).execute<DuplicateMatchRow>(sql`
      select c.id, c.full_name as "fullName", c.email,
             case when ${email}::citext is not null and c.email = ${email}::citext
                  then 'email' else 'name' end as "matchedOn",
             similarity(c.full_name, ${fullName}) as similarity
        from candidates c
       where c.anonymized_at is null
         and (
           (${email}::citext is not null and c.email = ${email}::citext)
           or similarity(c.full_name, ${fullName}) >= ${threshold}
         )
       order by "matchedOn" asc, similarity desc
       limit 10
    `);
    return result.rows;
  }

  async insert(tx: TxScope, input: InsertCandidateInput): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into candidates (
        company_id, full_name, email, phone, current_title, current_employer,
        total_experience_years, current_ctc, ctc_currency, education_level,
        location_city, location_country, linkedin_url, source, created_by
      ) values (
        ${input.companyId}, ${input.fullName}, ${input.email}, ${input.phone},
        ${input.currentTitle}, ${input.currentEmployer}, ${input.totalExperienceYears},
        ${input.currentCtc}, ${input.ctcCurrency}, ${input.educationLevel},
        ${input.locationCity}, ${input.locationCountry}, ${input.linkedinUrl},
        ${input.source}, ${input.createdBy}
      )
      returning id
    `);

    const row = result.rows[0];
    if (row === undefined) throw new Error('candidate insert returned no row');
    return row;
  }

  /**
   * Patches only the keys present.
   *
   * `current_ctc` is updatable here and frozen on every existing application
   * (BR-055): the profile is the current truth, the snapshot is what was true
   * at submission, and both being right at once is the point of D-009.
   */
  async update(tx: TxScope, id: string, input: UpdateCandidateInput): Promise<boolean> {
    const assignments = buildAssignments(input);
    if (assignments.length === 0) return true;

    const result = await unwrapTxScope(tx).execute(sql`
      update candidates set ${sql.join(assignments, sql`, `)}
       where id = ${id} and anonymized_at is null
    `);
    return (result.rowCount ?? 0) > 0;
  }

  /** Points the profile at a newly uploaded resume (T-064). */
  async setCurrentResume(tx: TxScope, candidateId: string, resumeId: string): Promise<void> {
    await unwrapTxScope(tx).execute(sql`
      update candidates set current_resume_id = ${resumeId}
       where id = ${candidateId}
    `);
  }
}

/**
 * One `column = $n` fragment per supplied key.
 *
 * Column names are literal text in this file and never come from the request
 * — the mapping below is the allowlist (ER-031, SEC-042). A key the client
 * invents does not appear here and so cannot reach the statement.
 */
function buildAssignments(input: UpdateCandidateInput): ReturnType<typeof sql>[] {
  const pairs: [keyof UpdateCandidateInput, ReturnType<typeof sql>][] = [
    ['fullName', sql`full_name`],
    ['phone', sql`phone`],
    ['currentTitle', sql`current_title`],
    ['currentEmployer', sql`current_employer`],
    ['totalExperienceYears', sql`total_experience_years`],
    ['currentCtc', sql`current_ctc`],
    ['ctcCurrency', sql`ctc_currency`],
    ['educationLevel', sql`education_level`],
    ['locationCity', sql`location_city`],
    ['locationCountry', sql`location_country`],
    ['linkedinUrl', sql`linkedin_url`],
  ];

  const assignments: ReturnType<typeof sql>[] = [];
  for (const [key, column] of pairs) {
    const value = input[key];
    if (value !== undefined) assignments.push(sql`${column} = ${value}`);
  }
  return assignments;
}
