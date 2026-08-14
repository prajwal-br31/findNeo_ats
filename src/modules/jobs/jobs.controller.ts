import type { FieldVisibility } from '../../shared/authz/masking.js';
import type { ResolvedPermissions } from '../../shared/authz/permission-cache.js';
import type { RowScopeContext } from '../../shared/authz/row-scope.js';
import { unsafeCompanyId, unsafeUserId } from '../../shared/types/ids.js';

import type { FormsService } from './application/forms.service.js';
import type { JobsService } from './application/jobs.service.js';
import type { PipelineService } from './application/pipeline.service.js';
import { toJobListViews, toJobView, type JobListView, type JobView } from './jobs.mapper.js';
import type {
  AddTeamMemberBody,
  CreateJobBody,
  CreateStageBody,
  CreateTemplateBody,
  ReplaceFieldsBody,
  UpdateJobBody,
} from './jobs.schemas.js';

/**
 * Jobs controller (ER-002).
 *
 * The caller's resolved permissions and department ids arrive as a `JobScope`
 * rather than being looked up here: they are established once per request by
 * the authorization pipeline, and re-resolving them per query would both cost
 * a round trip and risk the two disagreeing.
 */

export interface RequestActor {
  readonly companyId: string;
  readonly userId: string;
  readonly permissions: ResolvedPermissions;
  readonly visibility: FieldVisibility;
}

function scopeOf(actor: RequestActor): RowScopeContext {
  return {
    userId: actor.userId,
    departmentIds: actor.permissions.departmentIds,
    permissions: actor.permissions.keys,
  };
}

export class JobsController {
  readonly #jobs: JobsService;
  readonly #forms: FormsService;
  readonly #pipeline: PipelineService;

  constructor(jobs: JobsService, forms: FormsService, pipeline: PipelineService) {
    this.#jobs = jobs;
    this.#forms = forms;
    this.#pipeline = pipeline;
  }

  /* ------------------------------------------------------------------ jobs -- */

  async listJobs(actor: RequestActor): Promise<JobListView[]> {
    const rows = await this.#jobs.list(unsafeCompanyId(actor.companyId), scopeOf(actor));
    /* Masked in the list too, not only on the single resource (BR-091). */
    return toJobListViews(rows, actor.visibility, actor.permissions);
  }

  async getJob(actor: RequestActor, id: string): Promise<JobView> {
    const row = await this.#jobs.get(unsafeCompanyId(actor.companyId), scopeOf(actor), id);
    return toJobView(row, actor.visibility, actor.permissions);
  }

  async createJob(actor: RequestActor, body: CreateJobBody): Promise<{ id: string }> {
    return this.#jobs.create(unsafeCompanyId(actor.companyId), unsafeUserId(actor.userId), {
      title: body.title,
      departmentId: body.departmentId,
      description: body.description ?? null,
      employmentType: body.employmentType ?? null,
      workMode: body.workMode ?? null,
      countryCode: body.countryCode ?? null,
      city: body.city ?? null,
      headcount: body.headcount ?? 1,
      salaryMin: body.salaryMin ?? null,
      salaryMax: body.salaryMax ?? null,
      salaryCurrency: body.salaryCurrency ?? null,
      pipelineTemplateId: body.pipelineTemplateId ?? null,
      skills: body.skills ?? [],
      customFields: body.customFields ?? {},
    });
  }

  async updateJob(actor: RequestActor, id: string, body: UpdateJobBody): Promise<void> {
    await this.#jobs.update(unsafeCompanyId(actor.companyId), scopeOf(actor), id, {
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.customFields === undefined ? {} : { customFields: body.customFields }),
    });
  }

  async deleteJob(actor: RequestActor, id: string): Promise<void> {
    await this.#jobs.delete(unsafeCompanyId(actor.companyId), scopeOf(actor), id);
  }

  async publishJob(actor: RequestActor, id: string): Promise<void> {
    await this.#jobs.publish(unsafeCompanyId(actor.companyId), scopeOf(actor), id);
  }

  async closeJob(actor: RequestActor, id: string): Promise<void> {
    await this.#jobs.close(unsafeCompanyId(actor.companyId), scopeOf(actor), id);
  }

  async holdJob(actor: RequestActor, id: string): Promise<void> {
    await this.#jobs.hold(unsafeCompanyId(actor.companyId), scopeOf(actor), id);
  }

  async reopenJob(actor: RequestActor, id: string): Promise<void> {
    await this.#jobs.reopen(unsafeCompanyId(actor.companyId), scopeOf(actor), id);
  }

  async setConfidential(actor: RequestActor, id: string, confidential: boolean): Promise<void> {
    await this.#jobs.setConfidential(
      unsafeCompanyId(actor.companyId),
      scopeOf(actor),
      id,
      confidential,
    );
  }

  /* ----------------------------------------------------------------- forms -- */

  async listTemplates(actor: RequestActor): Promise<unknown[]> {
    return this.#forms.listTemplates(unsafeCompanyId(actor.companyId));
  }

  async activeForm(
    actor: RequestActor,
    entityType: string,
  ): Promise<{ versionId: string; versionNo: number; fields: unknown[] }> {
    const active = await this.#forms.activeVersion(unsafeCompanyId(actor.companyId), entityType);
    return {
      versionId: active.version.id,
      versionNo: active.version.versionNo,
      fields: [...active.fields],
    };
  }

  async createTemplate(actor: RequestActor, body: CreateTemplateBody): Promise<{ id: string }> {
    return this.#forms.createTemplate(
      unsafeCompanyId(actor.companyId),
      unsafeUserId(actor.userId),
      body.entityType,
      body.name,
    );
  }

  async createVersion(actor: RequestActor, templateId: string): Promise<{ id: string }> {
    return this.#forms.createVersion(unsafeCompanyId(actor.companyId), templateId);
  }

  async replaceFields(
    actor: RequestActor,
    versionId: string,
    body: ReplaceFieldsBody,
  ): Promise<void> {
    await this.#forms.replaceFields(
      unsafeCompanyId(actor.companyId),
      versionId,
      body.fields.map((field) => ({
        key: field.key,
        label: field.label,
        dataType: field.dataType as never,
        isRequired: field.isRequired,
        options: field.options,
        maxLength: field.maxLength,
        minValue: field.minValue,
        maxValue: field.maxValue,
        sequenceOrder: field.sequenceOrder,
      })),
    );
  }

  async publishVersion(actor: RequestActor, versionId: string): Promise<void> {
    await this.#forms.publishVersion(
      unsafeCompanyId(actor.companyId),
      versionId,
      unsafeUserId(actor.userId),
    );
  }

  /* -------------------------------------------------------------- pipeline -- */

  async listStages(actor: RequestActor, jobId: string): Promise<unknown[]> {
    return this.#pipeline.listStages(unsafeCompanyId(actor.companyId), scopeOf(actor), jobId);
  }

  async addStage(
    actor: RequestActor,
    jobId: string,
    body: CreateStageBody,
  ): Promise<{ id: string }> {
    return this.#pipeline.addStage(unsafeCompanyId(actor.companyId), scopeOf(actor), jobId, {
      name: body.name,
      stageType: body.stageType,
      isTerminal: body.isTerminal,
    });
  }

  async renameStage(
    actor: RequestActor,
    jobId: string,
    stageId: string,
    name: string,
  ): Promise<void> {
    await this.#pipeline.renameStage(
      unsafeCompanyId(actor.companyId),
      scopeOf(actor),
      jobId,
      stageId,
      name,
    );
  }

  async deleteStage(actor: RequestActor, jobId: string, stageId: string): Promise<void> {
    await this.#pipeline.deleteStage(
      unsafeCompanyId(actor.companyId),
      scopeOf(actor),
      jobId,
      stageId,
    );
  }

  async reorderStages(
    actor: RequestActor,
    jobId: string,
    stageIds: readonly string[],
  ): Promise<void> {
    await this.#pipeline.reorderStages(
      unsafeCompanyId(actor.companyId),
      scopeOf(actor),
      jobId,
      stageIds,
    );
  }

  async listTeam(actor: RequestActor, jobId: string): Promise<unknown[]> {
    return this.#pipeline.listTeam(unsafeCompanyId(actor.companyId), scopeOf(actor), jobId);
  }

  async addTeamMember(actor: RequestActor, jobId: string, body: AddTeamMemberBody): Promise<void> {
    await this.#pipeline.addTeamMember(
      unsafeCompanyId(actor.companyId),
      scopeOf(actor),
      jobId,
      unsafeUserId(body.userId),
      body.teamRole,
      unsafeUserId(actor.userId),
    );
  }

  async removeTeamMember(actor: RequestActor, jobId: string, userId: string): Promise<void> {
    await this.#pipeline.removeTeamMember(
      unsafeCompanyId(actor.companyId),
      scopeOf(actor),
      jobId,
      unsafeUserId(userId),
    );
  }

  async listSkills(actor: RequestActor): Promise<unknown[]> {
    return this.#pipeline.listSkills(unsafeCompanyId(actor.companyId));
  }

  async listJobSkills(actor: RequestActor, jobId: string): Promise<unknown[]> {
    return this.#pipeline.listJobSkills(unsafeCompanyId(actor.companyId), scopeOf(actor), jobId);
  }

  async removeJobSkill(actor: RequestActor, jobId: string, skillId: string): Promise<void> {
    await this.#pipeline.removeJobSkill(
      unsafeCompanyId(actor.companyId),
      scopeOf(actor),
      jobId,
      skillId,
    );
  }

  async listPipelineTemplates(actor: RequestActor): Promise<unknown[]> {
    return this.#pipeline.listTemplates(unsafeCompanyId(actor.companyId));
  }
}
