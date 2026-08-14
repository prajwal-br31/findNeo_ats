import { BusinessRuleError, conflict, notFound } from '../../../shared/errors/app-error.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type { JobScope } from '../infrastructure/job-scope.js';
import type { JobListRow, JobRow, JobsRepository } from '../infrastructure/jobs.repository.js';
import type { PipelineRepository } from '../infrastructure/pipeline.repository.js';
import type { FormsService } from './forms.service.js';

/**
 * Jobs (T-044, T-045, T-049).
 *
 * Creation is one transaction covering the job, its pipeline copy, its skills
 * and its hiring team (08-lld-jobs §4). Split, a crash leaves a job with no
 * stages — which cannot be published and cannot be fixed through the API,
 * because every stage endpoint is scoped to a job that is expected to have
 * some.
 */

export interface JobsServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: JobsRepository;
  readonly pipeline: PipelineRepository;
  readonly forms: FormsService;
}

export interface CreateJobInput {
  readonly title: string;
  readonly departmentId: string;
  readonly description: string | null;
  readonly employmentType: string | null;
  readonly workMode: string | null;
  readonly countryCode: string | null;
  readonly city: string | null;
  readonly headcount: number;
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly salaryCurrency: string | null;
  readonly pipelineTemplateId: string | null;
  readonly skills: readonly { name: string; weight: number; isMandatory: boolean }[];
  readonly customFields: unknown;
}

function slugify(name: string): string {
  /* Matching is on the slug, so "React", "react" and "React " must collapse
     to one catalog entry (D-029). */
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23503') return true;
    current = candidate.cause;
  }
  return false;
}

export class JobsService {
  readonly #deps: JobsServiceDeps;

  constructor(deps: JobsServiceDeps) {
    this.#deps = deps;
  }

  async list(companyId: CompanyId, scope: JobScope): Promise<JobListRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.list(tx, companyId, scope));
  }

  /** 404 covers "no such job", "another tenant's", and "confidential" alike. */
  async get(companyId: CompanyId, scope: JobScope, id: string): Promise<JobRow> {
    const { uow, repository } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const job = await repository.findById(tx, companyId, scope, id);
      if (job === undefined) throw notFound('Job not found.');
      return job;
    });
  }

  async create(
    companyId: CompanyId,
    createdBy: UserId,
    input: CreateJobInput,
  ): Promise<{ id: string }> {
    const { uow, repository, pipeline, forms } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      /* Resolve and pin the active version before anything is written. The
         job keeps rendering against this version forever (BR-046). */
      const active = await forms.activeVersionIn(tx, 'job');
      await forms.validateCustomFields(tx, companyId, active.id, input.customFields);

      let job: { id: string };
      try {
        job = await repository.insert(tx, {
          companyId,
          departmentId: input.departmentId,
          title: input.title,
          description: input.description,
          employmentType: input.employmentType,
          workMode: input.workMode,
          countryCode: input.countryCode,
          city: input.city,
          headcount: input.headcount,
          salaryMin: input.salaryMin,
          salaryMax: input.salaryMax,
          salaryCurrency: input.salaryCurrency,
          formTemplateVersionId: active.id,
          customFields: input.customFields,
          createdBy,
        });
      } catch (error) {
        /* The composite FK on (department_id, company_id) rejects a department
           from another tenant. 404, matching what RLS would have said. */
        if (isForeignKeyViolation(error)) throw notFound('Department not found.');
        throw error;
      }

      await this.#copyStages(tx, companyId, job.id, input.pipelineTemplateId);
      await this.#attachSkills(tx, companyId, job.id, input.skills);

      /* The creator joins the hiring team unless somebody else is named. A job
         nobody is on is a job its own author cannot see once they leave the
         department. */
      await pipeline.addTeamMember(tx, companyId, job.id, createdBy, 'hiring_manager', createdBy);

      return job;
    });
  }

  async #copyStages(
    tx: TxScope,
    companyId: CompanyId,
    jobId: string,
    templateId: string | null,
  ): Promise<void> {
    const { pipeline } = this.#deps;

    const resolved = templateId ?? (await pipeline.defaultTemplateId(tx));
    if (resolved === undefined) {
      throw new BusinessRuleError('BR-034', 'No pipeline template is available to copy.');
    }

    const copied = await pipeline.copyStagesFromTemplate(tx, companyId, jobId, resolved);
    if (copied === 0) {
      throw new BusinessRuleError('BR-034', 'The pipeline template has no stages.');
    }
  }

  async #attachSkills(
    tx: TxScope,
    companyId: CompanyId,
    jobId: string,
    skills: CreateJobInput['skills'],
  ): Promise<void> {
    const { pipeline } = this.#deps;

    for (const skill of skills) {
      const slug = slugify(skill.name);
      if (slug === '') continue;
      const skillId = await pipeline.findOrCreateSkill(tx, companyId, skill.name.trim(), slug);
      await pipeline.addJobSkill(tx, companyId, jobId, skillId, {
        minYears: null,
        isMandatory: skill.isMandatory,
        weight: skill.weight,
      });
    }
  }

  async update(
    companyId: CompanyId,
    scope: JobScope,
    id: string,
    patch: { title?: string; description?: string | null; customFields?: unknown },
  ): Promise<void> {
    const { uow, repository, forms } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const job = await repository.findById(tx, companyId, scope, id);
      if (job === undefined) throw notFound('Job not found.');

      /* Validated against the version the job was CREATED under, not the
         active one. A job pinned to v1 must keep accepting v1's fields even
         after v2 publishes (BR-046). */
      if (patch.customFields !== undefined) {
        await forms.validateCustomFields(
          tx,
          companyId,
          job.formTemplateVersionId,
          patch.customFields,
        );
      }

      await repository.updateFields(tx, id, patch);
    });
  }

  /** Draft only. Deleting anything else is an invalid transition (08 §7). */
  async delete(companyId: CompanyId, scope: JobScope, id: string): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const job = await repository.findById(tx, companyId, scope, id);
      if (job === undefined) throw notFound('Job not found.');
      if (job.status !== 'draft') {
        throw conflict('ERR_INVALID_TRANSITION', 'Only a draft job can be deleted.');
      }
      await repository.delete(tx, id);
    });
  }

  /**
   * Publish (T-049, 08 §4).
   *
   * Idempotent: publishing an already-open job returns without change rather
   * than erroring. A retry after a dropped response must not fail.
   */
  async publish(companyId: CompanyId, scope: JobScope, id: string): Promise<void> {
    const { uow, repository, pipeline } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const job = await repository.findById(tx, companyId, scope, id);
      if (job === undefined) throw notFound('Job not found.');
      if (job.status === 'open') return;
      if (job.status !== 'draft' && job.status !== 'on_hold') {
        throw conflict('ERR_INVALID_TRANSITION', 'Only a draft or held job can be published.');
      }

      const stages = await pipeline.listStages(tx, id);
      if (stages.length === 0) {
        throw new BusinessRuleError('BR-034', 'A job needs at least one pipeline stage.');
      }
      if (!stages.some((stage) => stage.isTerminal)) {
        throw new BusinessRuleError('BR-034', 'A job needs at least one terminal stage.');
      }
      if (job.employmentType === null) {
        throw new BusinessRuleError('BR-034', 'Employment type is required before publishing.');
      }

      await repository.markPublished(tx, id);
    });
  }

  async close(companyId: CompanyId, scope: JobScope, id: string): Promise<void> {
    await this.#transition(companyId, scope, id, 'closed');
  }

  async hold(companyId: CompanyId, scope: JobScope, id: string): Promise<void> {
    await this.#transition(companyId, scope, id, 'on_hold');
  }

  async reopen(companyId: CompanyId, scope: JobScope, id: string): Promise<void> {
    await this.#transition(companyId, scope, id, 'open');
  }

  async #transition(
    companyId: CompanyId,
    scope: JobScope,
    id: string,
    status: string,
  ): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const job = await repository.findById(tx, companyId, scope, id);
      if (job === undefined) throw notFound('Job not found.');
      await repository.setStatus(tx, id, status);
    });
  }

  /**
   * Set or clear `confidential` (T-049, BR-033).
   *
   * Setting it also withdraws the job publicly, in the same statement.
   * Clearing it does **not** republish: reappearing on a public careers page
   * must never be a side effect of clearing a private flag.
   */
  async setConfidential(
    companyId: CompanyId,
    scope: JobScope,
    id: string,
    confidential: boolean,
  ): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const job = await repository.findById(tx, companyId, scope, id);
      if (job === undefined) throw notFound('Job not found.');
      await repository.setConfidential(tx, id, confidential);
    });
  }
}
