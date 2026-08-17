import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createUnitOfWork, type UnitOfWorkHandle } from '../../../platform/db/unit-of-work.js';
import { notFound } from '../../../shared/errors/app-error.js';
import { seedTwoTenants, type TwoTenants } from '../../../testing/harness/seed-two-tenants.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';
import { CandidatesService } from '../application/candidates.service.js';
import { PoolService } from '../application/pool.service.js';
import { CandidatesRepository } from '../infrastructure/candidates.repository.js';
import { PoolRepository } from '../infrastructure/pool.repository.js';

/**
 * Cross-tenant leak tests for the Phase 3 tables (T-071, BR-001).
 *
 * Two tenants, and every assertion runs the *same* call twice: once as the
 * owner of the row and once as the other company. A test that only checks the
 * negative case passes just as happily when the query is broken and returns
 * nothing to anybody, so both directions are asserted every time.
 *
 * `talent_pool_entries` is named explicitly because its tenant column is
 * `owner_company_id` rather than `company_id` (06b §1). That deviation is the
 * single most likely place for an RLS policy to be written against the wrong
 * column, and it would fail open.
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
let tenants: TwoTenants;

let candidates: CandidatesService;
let pool: PoolService;

/** A candidate owned by alpha, created directly so the test controls the id. */
let alphaCandidateId: string;
/** The same, owned by beta. */
let betaCandidateId: string;

/**
 * Fails loudly on a missing fixture.
 *
 * The previous `?? ''` turned an absent row into an empty string, which then
 * surfaced three lines later as "invalid input syntax for type uuid" — an
 * error about the wrong thing, in the wrong place. A fixture that did not
 * materialise should say so.
 */
function required(value: string | undefined, what: string): string {
  if (value === undefined || value === '') throw new Error(`fixture missing: ${what}`);
  return value;
}

async function ownerClient(): Promise<Client> {
  const client = new Client({ connectionString: database.ownerUrl });
  await client.connect();
  return client;
}

/** Inserts as the migrator, which bypasses RLS, so the fixture is not the thing under test. */
async function seedCandidate(companyId: string, fullName: string): Promise<string> {
  const client = await ownerClient();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO candidates (company_id, full_name, email, current_ctc, ctc_currency)
       VALUES ($1, $2, $3, 1000000, 'INR') RETURNING id`,
      [companyId, fullName, `${fullName.toLowerCase().replace(/ /g, '.')}@example.test`],
    );
    return required(rows[0]?.id, `candidate ${fullName}`);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 6, applicationName: 'cand-it' });
  tenants = await seedTwoTenants(database);

  candidates = new CandidatesService({ uow: handle.uow, repository: new CandidatesRepository() });
  pool = new PoolService({ uow: handle.uow, repository: new PoolRepository() });

  alphaCandidateId = await seedCandidate(tenants.alpha.companyId, 'Alpha Person');
  betaCandidateId = await seedCandidate(tenants.beta.companyId, 'Beta Person');
}, 300_000);

afterAll(async () => {
  await handle.close();
  await database.drop();
});

/** Drizzle wraps driver errors, so the SQLSTATE sits on `cause`. */
function causeOf(error: unknown): unknown {
  const wrapped = (error as { cause?: unknown }).cause;
  return wrapped ?? error;
}

describe('T-071: candidates do not leak across tenants', () => {
  it('lists only its own candidates', async () => {
    const alphaPage = await candidates.list(tenants.alpha.companyId, {});
    const betaPage = await candidates.list(tenants.beta.companyId, {});

    /* Both directions. If the tenant filter were dropped entirely, each list
       would contain both rows and the first assertion alone would still
       pass — so the absence is asserted as well as the presence. */
    expect(alphaPage.data.map((row) => row.id)).toContain(alphaCandidateId);
    expect(alphaPage.data.map((row) => row.id)).not.toContain(betaCandidateId);

    expect(betaPage.data.map((row) => row.id)).toContain(betaCandidateId);
    expect(betaPage.data.map((row) => row.id)).not.toContain(alphaCandidateId);
  });

  it('answers 404, not 403, for another tenant’s candidate (SEC-026)', async () => {
    await expect(candidates.get(tenants.alpha.companyId, alphaCandidateId)).resolves.toMatchObject({
      id: alphaCandidateId,
    });

    /* 404 and not 403: a 403 would confirm the row exists, which is the
       existence leak SEC-026 exists to close. */
    await expect(candidates.get(tenants.alpha.companyId, betaCandidateId)).rejects.toMatchObject({
      code: notFound().code,
    });
  });

  it('does not surface another tenant’s candidate as a duplicate', async () => {
    /* Duplicate detection reads the whole tenant by design. If RLS were not
       applied to that read, one company could enumerate another's candidate
       list by guessing names — a worse leak than the ordinary list, because
       it is a probe rather than a page. */
    const matches = await candidates.findDuplicates(
      tenants.alpha.companyId,
      'Beta Person',
      'beta.person@example.test',
    );
    expect(matches.map((row) => row.id)).not.toContain(betaCandidateId);

    const own = await candidates.findDuplicates(
      tenants.alpha.companyId,
      'Alpha Person',
      'alpha.person@example.test',
    );
    expect(own.map((row) => row.id)).toContain(alphaCandidateId);
  });

  it('refuses to update another tenant’s candidate', async () => {
    await expect(
      candidates.update(tenants.alpha.companyId, betaCandidateId, { fullName: 'Renamed' }),
    ).rejects.toMatchObject({ code: notFound().code });

    const client = await ownerClient();
    try {
      const { rows } = await client.query<{ full_name: string }>(
        'SELECT full_name FROM candidates WHERE id = $1',
        [betaCandidateId],
      );
      expect(rows[0]?.full_name).toBe('Beta Person');
    } finally {
      await client.end();
    }
  });
});

describe('T-071: the talent pool is isolated by owner_company_id (BR-001)', () => {
  it('shows an org nothing of another company’s pool', async () => {
    await pool.add(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
      candidateId: alphaCandidateId,
      source: 'internal_add',
      notes: null,
      tags: ['alpha-only'],
    });
    await pool.add(tenants.beta.companyId, tenants.beta.ownerUserId, {
      candidateId: betaCandidateId,
      source: 'internal_add',
      notes: null,
      tags: ['beta-only'],
    });

    const alphaPool = await pool.list(tenants.alpha.companyId);
    const betaPool = await pool.list(tenants.beta.companyId);

    /* The column this policy reads is `owner_company_id`. A policy written
       against `company_id` would not compile against this table, but one
       written against the *candidate's* company would compile and be wrong
       in a way only this assertion catches. */
    expect(alphaPool.map((row) => row.candidateId)).toEqual([alphaCandidateId]);
    expect(betaPool.map((row) => row.candidateId)).toEqual([betaCandidateId]);
  });

  it('refuses to add another tenant’s candidate to a pool', async () => {
    /* The composite FK `(candidate_id, owner_company_id)` is what stops this,
       not application logic — so it holds for any future caller too.
       
       Asserted by SQLSTATE and constraint name rather than with a bare
       `toThrow()`: this case once passed because an unrelated array-binding
       bug threw first, which is exactly as useless as not having the test. */
    const rejection = await pool
      .add(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
        candidateId: betaCandidateId,
        source: 'internal_add',
        notes: null,
        tags: [],
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(rejection).toBeDefined();
    expect(causeOf(rejection)).toMatchObject({
      code: '23503',
      constraint: 'fk_pool_candidate',
    });
  });

  it('refuses to remove an entry belonging to another company', async () => {
    const betaPool = await pool.list(tenants.beta.companyId);
    const betaEntryId = required(betaPool[0]?.id, 'beta pool entry');

    await expect(pool.remove(tenants.alpha.companyId, betaEntryId)).rejects.toMatchObject({
      code: notFound().code,
    });

    expect((await pool.list(tenants.beta.companyId)).map((row) => row.id)).toContain(betaEntryId);
  });
});
