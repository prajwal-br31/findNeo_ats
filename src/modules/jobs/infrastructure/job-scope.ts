import { sql, type SQL } from 'drizzle-orm';

import type { RowScopeContext } from '../../../shared/authz/row-scope.js';

/**
 * The job row-scope predicate (T-045, 08-lld-jobs §3, 04 §4).
 *
 * **This is the pattern every later module copies.** It belongs in the query,
 * never as a post-fetch filter (SEC-022): filtering after the fact means the
 * rows were already read, the count is already wrong, and pagination silently
 * returns short pages.
 *
 * A job is visible if **any** of:
 *   1. the caller holds `jobs.read.all`, or
 *   2. it is NOT confidential and its department is one of the caller's, or
 *   3. it is confidential and the caller holds `jobs.confidential.read`, or
 *   4. the caller is on the job's hiring team.
 *
 * ## The mistake this is written to avoid
 *
 * Confidential is a **different branch**, not an extra filter. The natural
 * shape —
 *
 *     department_id = ANY(...) AND (NOT confidential OR hasConfidentialRead)
 *
 * — is wrong, and wrong in the direction that leaks. It reads as "you see your
 * departments, minus confidential ones you lack permission for", but a
 * department member holding no confidential permission still matches the first
 * conjunct on a confidential job in their own department. BR-031 says
 * department membership alone must *never* reveal a confidential job, so the
 * department branch is guarded by `NOT confidential` inside its own arm and
 * confidential access comes only from arm 3 or arm 4.
 *
 * `departmentIds` is resolved once per request by the authorization pipeline,
 * not per query.
 */

/** Declared in `shared/authz` so the controller can build one (ER-002). */
export type JobScope = RowScopeContext;

export function jobScopePredicate(scope: JobScope): SQL {
  /* Still inside RLS and the explicit company filter the caller composes on
     top (ER-020). "All jobs" means all of this tenant's jobs. */
  if (scope.permissions.has('jobs.read.all')) return sql`true`;

  const canSeeConfidential = scope.permissions.has('jobs.confidential.read');

  /* An empty department list becomes an explicit `false` rather than an empty
     IN list — the arm must be unmistakably closed, and an empty `IN ()` is a
     syntax error rather than a no-match.

     `IN` with one bind parameter per id, not `= ANY(array)`: Drizzle
     serialises a JS array as a JSON-style `[a,b]` and Postgres wants `{a,b}`,
     which fails at runtime with 22P02. Still fully parameterised — nothing is
     interpolated into the statement (ER-031, SEC-042). */
  const departmentArm =
    scope.departmentIds.length === 0
      ? sql`false`
      : sql`(NOT j.confidential AND j.department_id IN (${sql.join(
          scope.departmentIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}))`;

  return sql`(
    ${departmentArm}
    OR (j.confidential AND ${canSeeConfidential})
    OR EXISTS (
      SELECT 1 FROM job_hiring_team t
       WHERE t.job_id = j.id AND t.user_id = ${scope.userId}
    )
  )`;
}
