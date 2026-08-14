import { describe, expect, it } from 'vitest';

import { jobScopePredicate, type JobScope } from '../infrastructure/job-scope.js';

/**
 * T-045 — the row-scope predicate, as SQL text.
 *
 * These assert the *shape* of the generated predicate rather than its effect;
 * the effect is asserted against a real database in `jobs.test.ts`. Both are
 * needed: the database test proves the query is right today, and this one
 * pins the structure that BR-031 depends on, so a refactor that flattens the
 * branches fails here with a readable diff rather than there with a leak.
 */

function scope(overrides: Partial<JobScope> = {}): JobScope {
  return {
    userId: '00000000-0000-0000-0000-0000000000aa',
    departmentIds: [],
    permissions: new Set<string>(),
    ...overrides,
  };
}

/** Drizzle's SQL object exposes its chunks; joining them gives the shape. */
function toText(fragment: ReturnType<typeof jobScopePredicate>): string {
  const chunks = (fragment as unknown as { queryChunks: unknown[] }).queryChunks;
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      const value = chunk as { value?: unknown };
      return Array.isArray(value.value) ? value.value.join('') : '?';
    })
    .join('');
}

describe('T-045: jobs.read.all short-circuits', () => {
  it('returns a bare true', () => {
    /* Still inside RLS and the explicit company filter the caller composes on
       top (ER-020) — "all jobs" means all of this tenant's jobs. */
    const text = toText(jobScopePredicate(scope({ permissions: new Set(['jobs.read.all']) })));
    expect(text.trim()).toBe('true');
  });
});

describe('T-045: confidential is a branch, not a filter (BR-031)', () => {
  it('guards the department arm with NOT confidential', () => {
    const text = toText(
      jobScopePredicate(scope({ departmentIds: ['00000000-0000-0000-0000-0000000000d1'] })),
    );

    /* The mistake this exists to prevent is
         department_id = ANY(...) AND (NOT confidential OR hasPermission)
       which lets a department member see a confidential job in their own
       department. `NOT j.confidential` must sit inside the department arm. */
    expect(text).toContain('NOT j.confidential AND j.department_id IN');
  });

  it('puts confidential access in its own arm', () => {
    const text = toText(
      jobScopePredicate(
        scope({
          departmentIds: ['00000000-0000-0000-0000-0000000000d1'],
          permissions: new Set(['jobs.confidential.read']),
        }),
      ),
    );
    expect(text).toContain('j.confidential AND');
  });

  it('always offers the hiring-team arm', () => {
    /* Arm 4 is how a hiring-team member sees a confidential job they have no
       department claim on. */
    const text = toText(jobScopePredicate(scope()));
    expect(text).toContain('job_hiring_team');
  });
});

describe('T-045: the department arm is bounded and parameterised', () => {
  it('closes the department arm explicitly when there are no departments', () => {
    /* An empty IN list is a syntax error rather than a no-match, so the arm
       becomes a literal false. */
    const text = toText(jobScopePredicate(scope({ departmentIds: [] })));
    expect(text).toContain('false');
    expect(text).not.toContain('department_id IN ()');
  });

  it('binds department ids as parameters, never interpolated', () => {
    /* ER-031, SEC-042: `IN` with one bind per id, not an array literal and not
       string concatenation. */
    const text = toText(
      jobScopePredicate(
        scope({
          departmentIds: [
            '00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-0000000000d2',
          ],
        }),
      ),
    );
    expect(text).not.toContain('00000000-0000-0000-0000-0000000000d1');
  });
});
