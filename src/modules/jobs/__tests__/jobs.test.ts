import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LruCacheAdapter } from '../../../platform/cache/lru-cache-adapter.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../../../platform/db/unit-of-work.js';
import { FieldVisibility } from '../../../shared/authz/masking.js';
import type { ResolvedPermissions } from '../../../shared/authz/permission-cache.js';
import { seedTwoTenants, type TwoTenants } from '../../../testing/harness/seed-two-tenants.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/harness/test-database.js';
import { FieldVisibilityService } from '../../identity/application/field-visibility.service.js';
import { FieldVisibilityRepository } from '../../identity/infrastructure/field-visibility.repository.js';
import { FormsService } from '../application/forms.service.js';
import { JobsService } from '../application/jobs.service.js';
import { PipelineService } from '../application/pipeline.service.js';
import { FormsRepository } from '../infrastructure/forms.repository.js';
import type { JobScope } from '../infrastructure/job-scope.js';
import { JobsRepository } from '../infrastructure/jobs.repository.js';
import { PipelineRepository } from '../infrastructure/pipeline.repository.js';
import { toJobView, toJobViews } from '../jobs.mapper.js';

/**
 * T-044 … T-051 against a real database.
 *
 * The Phase 2 gate lives here: department scope, the confidential branch
 * (BR-031), salary masking in lists as well as single resources (BR-091),
 * version pinning (BR-046), confidential withdrawal (BR-033), and reorder
 * under the unique constraint.
 */

let database: TestDatabase;
let handle: UnitOfWorkHandle;
let tenants: TwoTenants;

let jobs: JobsService;
let forms: FormsService;
let pipeline: PipelineService;
let visibility: FieldVisibility;

/** Alpha's engineering department, plus a second one nobody is a member of. */
let otherDepartmentId: string;

function permissionsOf(keys: string[], departmentIds: string[] = []): ResolvedPermissions {
  return { keys: new Set(keys), departmentIds };
}

function scopeOf(userId: string, permissions: ResolvedPermissions): JobScope {
  return { userId, departmentIds: permissions.departmentIds, permissions: permissions.keys };
}

async function ownerClient(): Promise<Client> {
  const client = new Client({ connectionString: database.ownerUrl });
  await client.connect();
  return client;
}

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 6, applicationName: 'jobs-it' });
  tenants = await seedTwoTenants(database);

  const cache = new LruCacheAdapter();
  const jobsRepository = new JobsRepository();
  const pipelineRepository = new PipelineRepository();

  forms = new FormsService({ uow: handle.uow, repository: new FormsRepository(), cache });
  jobs = new JobsService({
    uow: handle.uow,
    repository: jobsRepository,
    pipeline: pipelineRepository,
    forms,
  });
  pipeline = new PipelineService({
    uow: handle.uow,
    repository: pipelineRepository,
    jobs: jobsRepository,
  });

  visibility = await new FieldVisibilityService({
    uow: handle.uow,
    repository: new FieldVisibilityRepository(),
    cache,
  }).resolve(tenants.alpha.companyId);

  const client = await ownerClient();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO departments (company_id, name) VALUES ($1, 'Sales') RETURNING id`,
      [tenants.alpha.companyId],
    );
    otherDepartmentId = rows[0]?.id ?? '';
  } finally {
    await client.end();
  }
}, 300_000);

afterAll(async () => {
  await handle.close();
  await database.drop();
});

const ALL = permissionsOf(['jobs.read.all', 'jobs.create', 'jobs.salary.read']);

async function createJob(
  departmentId: string,
  title: string,
  salaryMin: number | null = null,
): Promise<string> {
  const created = await jobs.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
    title,
    departmentId,
    description: null,
    employmentType: 'full_time',
    workMode: 'remote',
    countryCode: 'GB',
    city: null,
    headcount: 1,
    salaryMin,
    salaryMax: salaryMin === null ? null : salaryMin + 10_000,
    salaryCurrency: salaryMin === null ? null : 'GBP',
    pipelineTemplateId: null,
    skills: [{ name: 'TypeScript', weight: 8, isMandatory: true }],
    customFields: {},
  });
  return created.id;
}

describe('T-044: job creation is one transaction', () => {
  it('creates the job, copies stages, attaches skills and seeds the team', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Backend Engineer');

    const stages = await pipeline.listStages(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
    );
    /* The default template's six stages, copied once at creation. */
    expect(stages).toHaveLength(6);
    expect(stages.some((stage) => stage.isTerminal)).toBe(true);

    const team = await pipeline.listTeam(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
    );
    expect(team.some((member) => member.userId === tenants.alpha.ownerUserId)).toBe(true);

    const skills = await pipeline.listJobSkills(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
    );
    expect(skills).toHaveLength(1);
  }, 120_000);

  it('pins the active form version onto the job (BR-046)', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Pinned');
    const active = await forms.activeVersion(tenants.alpha.companyId, 'job');
    const job = await jobs.get(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
    );
    expect(job.formTemplateVersionId).toBe(active.version.id);
  }, 120_000);

  it('rejects a department from another tenant with 404', async () => {
    await expect(
      createJob(tenants.beta.departmentId, 'Cross-tenant department'),
    ).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
  }, 60_000);

  it('rejects custom fields that fail the pinned schema', async () => {
    await expect(
      jobs.create(tenants.alpha.companyId, tenants.alpha.ownerUserId, {
        title: 'Bad fields',
        departmentId: tenants.alpha.departmentId,
        description: null,
        employmentType: 'full_time',
        workMode: null,
        countryCode: null,
        city: null,
        headcount: 1,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        pipelineTemplateId: null,
        skills: [],
        /* `additionalProperties: false` — an undefined key cannot be smuggled. */
        customFields: { not_a_declared_field: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'ERR_VALIDATION_FAILED' });
  }, 60_000);
});

describe('T-045: department scope', () => {
  it('a hiring manager sees their own department’s jobs', async () => {
    const mine = await createJob(tenants.alpha.departmentId, 'In my department');
    await createJob(otherDepartmentId, 'In another department');

    const scoped = permissionsOf(['jobs.read'], [tenants.alpha.departmentId]);
    const visible = await jobs.list(
      tenants.alpha.companyId,
      scopeOf('00000000-0000-0000-0000-0000000000ff', scoped),
    );

    expect(visible.some((job) => job.id === mine)).toBe(true);
    expect(visible.every((job) => job.departmentId === tenants.alpha.departmentId)).toBe(true);
  }, 120_000);

  it('sees a job they are on the hiring team of, outside their departments', async () => {
    const jobId = await createJob(otherDepartmentId, 'Team-only visibility');

    const scoped = permissionsOf(['jobs.read'], [tenants.alpha.departmentId]);
    const asOwner = await jobs.list(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, scoped),
    );
    /* The creator was added to the hiring team, so arm 4 carries them. */
    expect(asOwner.some((job) => job.id === jobId)).toBe(true);
  }, 120_000);
});

describe('T-045: BR-031 — department membership never reveals a confidential job', () => {
  it('hides a confidential job in the caller’s own department', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Confidential in my department');
    await jobs.setConfidential(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
      true,
    );

    /* A different user, in the department, with no confidential permission and
       not on the hiring team. This is the exact case the flattened predicate
       would leak. */
    const member = permissionsOf(['jobs.read'], [tenants.alpha.departmentId]);
    const visible = await jobs.list(
      tenants.alpha.companyId,
      scopeOf('00000000-0000-0000-0000-0000000000ff', member),
    );
    expect(visible.some((job) => job.id === jobId)).toBe(false);
  }, 120_000);

  it('404s on direct fetch rather than 403 (BR-002)', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Confidential direct fetch');
    await jobs.setConfidential(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
      true,
    );

    const member = permissionsOf(['jobs.read'], [tenants.alpha.departmentId]);
    await expect(
      jobs.get(
        tenants.alpha.companyId,
        scopeOf('00000000-0000-0000-0000-0000000000ff', member),
        jobId,
      ),
    ).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
  }, 120_000);

  it('reveals it to a holder of jobs.confidential.read', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Confidential but permitted');
    await jobs.setConfidential(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
      true,
    );

    const permitted = permissionsOf(
      ['jobs.read', 'jobs.confidential.read'],
      [tenants.alpha.departmentId],
    );
    const visible = await jobs.list(
      tenants.alpha.companyId,
      scopeOf('00000000-0000-0000-0000-0000000000ff', permitted),
    );
    expect(visible.some((job) => job.id === jobId)).toBe(true);
  }, 120_000);
});

describe('T-049: confidential withdrawal (BR-033)', () => {
  it('setting confidential withdraws a published job', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Published then hidden');
    await jobs.publish(tenants.alpha.companyId, scopeOf(tenants.alpha.ownerUserId, ALL), jobId);

    await jobs.setConfidential(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
      true,
    );

    const job = await jobs.get(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
    );
    expect(job.publishToCareerSite).toBe(false);
    expect(job.publishedAt).toBeNull();
  }, 120_000);

  it('clearing confidential does NOT republish', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Hidden then revealed');
    await jobs.publish(tenants.alpha.companyId, scopeOf(tenants.alpha.ownerUserId, ALL), jobId);
    const scope = scopeOf(tenants.alpha.ownerUserId, ALL);

    await jobs.setConfidential(tenants.alpha.companyId, scope, jobId, true);
    await jobs.setConfidential(tenants.alpha.companyId, scope, jobId, false);

    /* Reappearing on a public careers page must never be a side effect of
       clearing a private flag. */
    const job = await jobs.get(tenants.alpha.companyId, scope, jobId);
    expect(job.confidential).toBe(false);
    expect(job.publishToCareerSite).toBe(false);
  }, 120_000);
});

describe('T-049: publish preconditions', () => {
  it('is idempotent', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Published twice');
    const scope = scopeOf(tenants.alpha.ownerUserId, ALL);
    await jobs.publish(tenants.alpha.companyId, scope, jobId);
    await expect(jobs.publish(tenants.alpha.companyId, scope, jobId)).resolves.toBeUndefined();
  }, 120_000);

  it('refuses a job with no terminal stage', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'No terminal stage');
    const scope = scopeOf(tenants.alpha.ownerUserId, ALL);

    const client = await ownerClient();
    try {
      await client.query(`UPDATE job_pipeline_stages SET is_terminal = false WHERE job_id = $1`, [
        jobId,
      ]);
    } finally {
      await client.end();
    }

    await expect(jobs.publish(tenants.alpha.companyId, scope, jobId)).rejects.toMatchObject({
      code: 'ERR_BUSINESS_RULE_VIOLATION',
    });
  }, 120_000);

  it('refuses to delete a non-draft job', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Published then deleted');
    const scope = scopeOf(tenants.alpha.ownerUserId, ALL);
    await jobs.publish(tenants.alpha.companyId, scope, jobId);

    await expect(jobs.delete(tenants.alpha.companyId, scope, jobId)).rejects.toMatchObject({
      code: 'ERR_INVALID_TRANSITION',
    });
  }, 120_000);
});

describe('T-050: salary masking (BR-091)', () => {
  it('masks salary for a caller without jobs.salary.read', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Paid role', 50_000);
    const row = await jobs.get(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
    );

    const withoutSalary = permissionsOf(['jobs.read']);
    const view = toJobView(row, visibility, withoutSalary);

    /* Nulled with a marker (07 §8), never omitted and never sent-with-a-flag. */
    expect(view.salaryMin).toBeNull();
    expect(view.salaryMax).toBeNull();
    expect(view['_masked']).toEqual(['salaryMin', 'salaryMax']);
  }, 120_000);

  it('shows salary to a holder', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Paid role visible', 60_000);
    const row = await jobs.get(
      tenants.alpha.companyId,
      scopeOf(tenants.alpha.ownerUserId, ALL),
      jobId,
    );
    const view = toJobView(row, visibility, permissionsOf(['jobs.read', 'jobs.salary.read']));
    expect(view.salaryMin).toBe(60_000);
    expect('_masked' in view).toBe(false);
  }, 120_000);

  it('masks in lists too, not only single resources', async () => {
    await createJob(tenants.alpha.departmentId, 'Listed paid role', 70_000);
    const rows = await jobs.list(tenants.alpha.companyId, scopeOf(tenants.alpha.ownerUserId, ALL));
    const views = toJobViews(rows, visibility, permissionsOf(['jobs.read']));

    /* A single-resource mapper that lists forget to use is the standard way
       salary leaks through a collection endpoint. */
    expect(views.every((view) => view.salaryMin === null)).toBe(true);
  }, 120_000);
});

describe('T-046: stage reorder under the unique constraint', () => {
  it('reorders without violating uq_job_stage_order', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Reordered');
    const scope = scopeOf(tenants.alpha.ownerUserId, ALL);

    const before = await pipeline.listStages(tenants.alpha.companyId, scope, jobId);
    const reversed = [...before].reverse().map((stage) => stage.id);

    /* The two-phase shift: naive assignment collides mid-transaction. */
    await pipeline.reorderStages(tenants.alpha.companyId, scope, jobId, reversed);

    const after = await pipeline.listStages(tenants.alpha.companyId, scope, jobId);
    expect(after.map((stage) => stage.id)).toEqual(reversed);
    expect(after.map((stage) => stage.sequenceOrder)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 120_000);

  it('refuses a partial reorder', async () => {
    const jobId = await createJob(tenants.alpha.departmentId, 'Partial reorder');
    const scope = scopeOf(tenants.alpha.ownerUserId, ALL);
    const stages = await pipeline.listStages(tenants.alpha.companyId, scope, jobId);

    /* Omitted stages would be left parked at their shifted +1000 order — a
       pipeline that looks reordered and is quietly broken. */
    await expect(
      pipeline.reorderStages(tenants.alpha.companyId, scope, jobId, [stages[0]?.id ?? '']),
    ).rejects.toMatchObject({ code: 'ERR_CONFLICT' });
  }, 120_000);
});

describe('T-051: cross-tenant isolation', () => {
  it('beta cannot see an alpha job, even with jobs.read.all', async () => {
    const alphaJob = await createJob(tenants.alpha.departmentId, 'Alpha only job');

    const betaVisible = await jobs.list(
      tenants.beta.companyId,
      scopeOf(tenants.beta.ownerUserId, ALL),
    );
    expect(betaVisible.some((job) => job.id === alphaJob)).toBe(false);
  }, 120_000);

  it('beta gets 404 fetching an alpha job by id', async () => {
    const alphaJob = await createJob(tenants.alpha.departmentId, 'Alpha direct fetch');
    await expect(
      jobs.get(tenants.beta.companyId, scopeOf(tenants.beta.ownerUserId, ALL), alphaJob),
    ).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
  }, 120_000);

  it('beta cannot read an alpha job’s stages or team', async () => {
    const alphaJob = await createJob(tenants.alpha.departmentId, 'Alpha stages');
    const betaScope = scopeOf(tenants.beta.ownerUserId, ALL);

    await expect(
      pipeline.listStages(tenants.beta.companyId, betaScope, alphaJob),
    ).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
    await expect(
      pipeline.listTeam(tenants.beta.companyId, betaScope, alphaJob),
    ).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
  }, 120_000);

  it('the fixture really did seed a control tenant', () => {
    expect(tenants.beta.companyId).not.toBe(tenants.alpha.companyId);
  });
});
