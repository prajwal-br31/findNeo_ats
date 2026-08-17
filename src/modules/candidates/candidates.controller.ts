import type { FieldVisibility } from '../../shared/authz/masking.js';
import type { ResolvedPermissions } from '../../shared/authz/permission-cache.js';
import { unsafeCompanyId, unsafeUserId } from '../../shared/types/ids.js';

import type { ApplicationsService } from './application/applications.service.js';
import type { CandidatesService } from './application/candidates.service.js';
import type { DecisionsService } from './application/decisions.service.js';
import type { PoolService } from './application/pool.service.js';
import type { ResumesService } from './application/resumes.service.js';
import { toApplication, toApplications, type ApplicationView } from './applications.mapper.js';
import { toCandidate, toCandidates, type CandidateView } from './candidates.mapper.js';
import type {
  AddToPoolBody,
  CreateCandidateBody,
  DecisionBody,
  SubmitApplicationBody,
  TransferApplicationBody,
  UpdateCandidateBody,
} from './candidates.schemas.js';

/**
 * Candidates controller (ER-002).
 *
 * Thin by construction: it converts request shapes to service inputs and rows
 * to views. Every masking decision goes through the mappers, which is what
 * stops a new endpoint from serialising compensation by hand.
 */

export interface RequestActor {
  readonly companyId: string;
  readonly userId: string;
  readonly permissions: ResolvedPermissions;
  readonly visibility: FieldVisibility;
}

export interface CandidatesControllerDeps {
  readonly candidates: CandidatesService;
  readonly pool: PoolService;
  readonly resumes: ResumesService;
  readonly applications: ApplicationsService;
  readonly decisions: DecisionsService;
}

export class CandidatesController {
  readonly #deps: CandidatesControllerDeps;

  constructor(deps: CandidatesControllerDeps) {
    this.#deps = deps;
  }

  /* ------------------------------------------------------ candidates -- */

  async listCandidates(
    actor: RequestActor,
    query: { limit?: number; cursor?: string },
  ): Promise<{ data: CandidateView[]; pagination: unknown }> {
    const page = await this.#deps.candidates.list(unsafeCompanyId(actor.companyId), query);
    return {
      data: toCandidates(page.data, actor.visibility, actor.permissions),
      pagination: page.pagination,
    };
  }

  async getCandidate(actor: RequestActor, id: string): Promise<CandidateView> {
    const row = await this.#deps.candidates.get(unsafeCompanyId(actor.companyId), id);
    return toCandidate(row, actor.visibility, actor.permissions);
  }

  async createCandidate(
    actor: RequestActor,
    body: CreateCandidateBody,
  ): Promise<{ id: string; possibleDuplicates: unknown[] }> {
    const result = await this.#deps.candidates.create(
      unsafeCompanyId(actor.companyId),
      unsafeUserId(actor.userId),
      {
        fullName: body.fullName,
        email: body.email ?? null,
        phone: body.phone ?? null,
        currentTitle: body.currentTitle ?? null,
        currentEmployer: body.currentEmployer ?? null,
        totalExperienceYears: body.totalExperienceYears ?? null,
        currentCtc: body.currentCtc ?? null,
        ctcCurrency: body.ctcCurrency ?? null,
        educationLevel: body.educationLevel ?? null,
        locationCity: body.locationCity ?? null,
        locationCountry: body.locationCountry ?? null,
        linkedinUrl: body.linkedinUrl ?? null,
        source: body.source ?? 'internal_add',
      },
    );
    return { id: result.id, possibleDuplicates: [...result.possibleDuplicates] };
  }

  async updateCandidate(actor: RequestActor, id: string, body: UpdateCandidateBody): Promise<void> {
    await this.#deps.candidates.update(unsafeCompanyId(actor.companyId), id, body);
  }

  async findDuplicates(
    actor: RequestActor,
    fullName: string,
    email: string | undefined,
  ): Promise<unknown[]> {
    const rows = await this.#deps.candidates.findDuplicates(
      unsafeCompanyId(actor.companyId),
      fullName,
      email ?? null,
    );
    return [...rows];
  }

  /* ------------------------------------------------------------ pool -- */

  async listPool(actor: RequestActor, status?: string): Promise<unknown[]> {
    const rows = await this.#deps.pool.list(unsafeCompanyId(actor.companyId), status);
    return [...rows];
  }

  async addToPool(actor: RequestActor, body: AddToPoolBody): Promise<{ id: string }> {
    return this.#deps.pool.add(unsafeCompanyId(actor.companyId), unsafeUserId(actor.userId), {
      candidateId: body.candidateId,
      source: body.source ?? null,
      notes: body.notes ?? null,
      tags: body.tags ?? [],
    });
  }

  async setPoolStatus(actor: RequestActor, id: string, status: string): Promise<void> {
    await this.#deps.pool.setStatus(unsafeCompanyId(actor.companyId), id, status);
  }

  async removeFromPool(actor: RequestActor, id: string): Promise<void> {
    await this.#deps.pool.remove(unsafeCompanyId(actor.companyId), id);
  }

  /* --------------------------------------------------------- resumes -- */

  async listResumes(actor: RequestActor, candidateId: string): Promise<unknown[]> {
    const rows = await this.#deps.resumes.listForCandidate(
      unsafeCompanyId(actor.companyId),
      candidateId,
    );
    return [...rows];
  }

  async uploadResume(
    actor: RequestActor,
    candidateId: string,
    bytes: Buffer,
    originalFilename: string,
  ): Promise<{ id: string; contentType: string }> {
    return this.#deps.resumes.upload(unsafeCompanyId(actor.companyId), unsafeUserId(actor.userId), {
      candidateId,
      bytes,
      originalFilename,
    });
  }

  async downloadResume(
    actor: RequestActor,
    resumeId: string,
  ): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    return this.#deps.resumes.download(unsafeCompanyId(actor.companyId), resumeId);
  }

  /* ---------------------------------------------------- applications -- */

  async listApplicationsForJob(actor: RequestActor, jobId: string): Promise<ApplicationView[]> {
    const rows = await this.#deps.applications.listForJob(unsafeCompanyId(actor.companyId), jobId);
    return toApplications(rows, actor.visibility, actor.permissions);
  }

  async listApplicationsForCandidate(
    actor: RequestActor,
    candidateId: string,
  ): Promise<ApplicationView[]> {
    const rows = await this.#deps.applications.listForCandidate(
      unsafeCompanyId(actor.companyId),
      candidateId,
    );
    return toApplications(rows, actor.visibility, actor.permissions);
  }

  async getApplication(actor: RequestActor, id: string): Promise<ApplicationView> {
    const row = await this.#deps.applications.get(unsafeCompanyId(actor.companyId), id);
    return toApplication(row, actor.visibility, actor.permissions);
  }

  async submitApplication(
    actor: RequestActor,
    body: SubmitApplicationBody,
  ): Promise<{ id: string }> {
    return this.#deps.applications.submit(
      unsafeCompanyId(actor.companyId),
      unsafeUserId(actor.userId),
      {
        jobId: body.jobId,
        candidateId: body.candidateId,
        source: body.source ?? 'internal_add',
        customFields: body.customFields ?? {},
        expectedCtc: body.expectedCtc ?? null,
        noticePeriodDays: body.noticePeriodDays ?? null,
      },
    );
  }

  async transferApplication(
    actor: RequestActor,
    id: string,
    body: TransferApplicationBody,
  ): Promise<{ id: string }> {
    return this.#deps.applications.transfer(
      unsafeCompanyId(actor.companyId),
      unsafeUserId(actor.userId),
      id,
      body.targetJobId,
    );
  }

  async withdrawApplication(actor: RequestActor, id: string): Promise<void> {
    await this.#deps.applications.withdraw(unsafeCompanyId(actor.companyId), id);
  }

  /* ------------------------------------------------------- decisions -- */

  async decisionHistory(actor: RequestActor, applicationId: string): Promise<unknown[]> {
    const rows = await this.#deps.decisions.history(
      unsafeCompanyId(actor.companyId),
      applicationId,
    );
    return [...rows];
  }

  async listReasons(actor: RequestActor, decisionType: string): Promise<unknown[]> {
    const rows = await this.#deps.decisions.reasons(unsafeCompanyId(actor.companyId), decisionType);
    return [...rows];
  }

  async advance(actor: RequestActor, applicationId: string, body: DecisionBody): Promise<void> {
    await this.#deps.decisions.advance(
      unsafeCompanyId(actor.companyId),
      unsafeUserId(actor.userId),
      toCommand(applicationId, body),
    );
  }

  async reject(actor: RequestActor, applicationId: string, body: DecisionBody): Promise<void> {
    await this.#deps.decisions.reject(
      unsafeCompanyId(actor.companyId),
      unsafeUserId(actor.userId),
      toCommand(applicationId, body),
    );
  }

  async hold(actor: RequestActor, applicationId: string, body: DecisionBody): Promise<void> {
    await this.#deps.decisions.hold(
      unsafeCompanyId(actor.companyId),
      unsafeUserId(actor.userId),
      toCommand(applicationId, body),
    );
  }
}

function toCommand(
  applicationId: string,
  body: DecisionBody,
): {
  applicationId: string;
  toStageId?: string;
  reasonKeys: readonly string[];
  notes: string | null;
} {
  return {
    applicationId,
    ...(body.toStageId === undefined ? {} : { toStageId: body.toStageId }),
    reasonKeys: body.reasonKeys ?? [],
    notes: body.notes ?? null,
  };
}
