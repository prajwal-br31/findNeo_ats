import {
  AppError,
  BusinessRuleError,
  conflict,
  notFound,
} from '../../../shared/errors/app-error.js';
import type { QueuePort } from '../../../shared/ports/queue.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type {
  ApplicationRow,
  ApplicationsRepository,
  ApplicationSnapshot,
} from '../infrastructure/applications.repository.js';
import type { CandidatesRepository } from '../infrastructure/candidates.repository.js';
import type { ResumesRepository } from '../infrastructure/resumes.repository.js';
import type { StageReader } from './stage-reader.js';

/**
 * Application submission and lifecycle (T-065, T-068, T-069).
 *
 * The submission is one transaction: the snapshot, the pipeline placement and
 * the resume-copy job all commit together or none of them do (ER-028). An
 * application that exists without its copy job would show a hiring team a
 * resume that later changes under them.
 */

const DEFAULT_PAGE = 100;

export interface ApplicationsServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: ApplicationsRepository;
  readonly candidates: CandidatesRepository;
  readonly resumes: ResumesRepository;
  readonly pipeline: StageReader;
  readonly queue: QueuePort;
}

export interface SubmitApplicationInput {
  readonly jobId: string;
  readonly candidateId: string;
  readonly source: string;
  readonly customFields: unknown;
  /** What the applicant stated for this role, which may differ from profile. */
  readonly expectedCtc: number | null;
  readonly noticePeriodDays: number | null;
}

export class ApplicationsService {
  readonly #deps: ApplicationsServiceDeps;

  constructor(deps: ApplicationsServiceDeps) {
    this.#deps = deps;
  }

  async listForJob(companyId: CompanyId, jobId: string): Promise<ApplicationRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) =>
      repository.listForJob(tx, jobId, DEFAULT_PAGE),
    );
  }

  async listForCandidate(companyId: CompanyId, candidateId: string): Promise<ApplicationRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) =>
      repository.listForCandidate(tx, candidateId, DEFAULT_PAGE),
    );
  }

  async get(companyId: CompanyId, id: string): Promise<ApplicationRow> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, async (tx: TxScope) => {
      const row = await repository.findById(tx, id);
      if (row === undefined) throw notFound('Application not found.');
      return row;
    });
  }

  /**
   * Submits an application (BR-055 through BR-060).
   *
   * The snapshot is assembled from the candidate profile *as it is right now*
   * plus the two fields the applicant states per role. From this moment the
   * two diverge permanently: BR-056 forbids any update path to these columns,
   * and there is none in the repository.
   *
   * The cap is left to `trg_application_cap` (BR-057, BR-058). Checking it
   * here as well would be a check-then-act race, and worse, it would become
   * the check a reader trusts.
   */
  async submit(
    companyId: CompanyId,
    userId: UserId,
    input: SubmitApplicationInput,
  ): Promise<{ id: string }> {
    const { uow, candidates, resumes, pipeline, queue } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const candidate = await candidates.findById(tx, input.candidateId);
      if (candidate === undefined) throw notFound('Candidate not found.');

      const stages = await pipeline.listStages(tx, input.jobId);
      const first = stages[0];
      /* A job with no pipeline cannot receive applications. Publishing checks
         this too; an application arriving anyway means the job was drafted
         through some other path, and placing it nowhere is worse than
         refusing. */
      if (first === undefined) {
        throw new BusinessRuleError('BR-063', 'This job has no pipeline stages yet.');
      }

      const job = await this.#requireJobTemplate(tx, input.jobId);

      const created = await this.#insertWithCapTranslation(tx, {
        companyId,
        jobId: input.jobId,
        candidateId: input.candidateId,
        currentStageId: first.id,
        source: input.source,
        ownerUserId: userId,
        formTemplateVersionId: job.formTemplateVersionId,
        customFields: input.customFields,
        transferredFromId: null,
        snapshot: toSnapshot(candidate, input),
      });

      /* The resume is COPIED, not referenced (BR-060, D-011). Enqueued in this
         transaction so the job cannot fire for an application that rolled
         back, and cannot be lost if the process dies after the commit. */
      const current = await resumes.findCurrentForCandidate(tx, input.candidateId);
      if (current !== undefined) {
        await queue.enqueue(tx, 'documents', 'resume.copy_for_application', {
          companyId,
          applicationId: created.id,
          sourceResumeId: current.id,
        } as never);
      }

      return created;
    });
  }

  /**
   * Non-destructive transfer (BR-062, D-033).
   *
   * The source application is marked `transferred` and keeps every decision
   * and interview attached to it — permanently. A new application is created
   * on the target job carrying the profile forward, **except expected
   * compensation**, which is role-specific and would be a fabrication on a
   * job the candidate never quoted for.
   *
   * The new job's hiring team does not inherit visibility of the old job's
   * feedback: that falls out of the scope query, since feedback hangs off the
   * source application and the source job.
   */
  async transfer(
    companyId: CompanyId,
    userId: UserId,
    applicationId: string,
    targetJobId: string,
  ): Promise<{ id: string }> {
    const { uow, repository, pipeline } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const source = await repository.findById(tx, applicationId);
      if (source === undefined) throw notFound('Application not found.');
      if (source.status !== 'active') {
        throw new BusinessRuleError('BR-062', 'Only an active application can be transferred.');
      }
      if (source.jobId === targetJobId) {
        throw new BusinessRuleError('BR-062', 'The application is already on that job.');
      }

      const stages = await pipeline.listStages(tx, targetJobId);
      const first = stages[0];
      if (first === undefined) {
        throw new BusinessRuleError('BR-063', 'The target job has no pipeline stages yet.');
      }

      const target = await this.#requireJobTemplate(tx, targetJobId);

      /* Marked first. If the insert then trips the cap, the whole transaction
         rolls back and the source is untouched — the two must not be able to
         disagree. */
      await repository.setStatus(tx, applicationId, 'transferred');

      return this.#insertWithCapTranslation(tx, {
        companyId,
        jobId: targetJobId,
        candidateId: source.candidateId,
        currentStageId: first.id,
        source: source.source,
        ownerUserId: userId,
        formTemplateVersionId: target.formTemplateVersionId,
        customFields: {},
        transferredFromId: applicationId,
        snapshot: carryForward(source),
      });
    });
  }

  /**
   * Withdrawal (T-069).
   *
   * Terminal and one-way. A withdrawn application frees the candidate's cap
   * slot, which is what lets someone withdraw and apply elsewhere.
   */
  async withdraw(companyId: CompanyId, applicationId: string): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const application = await repository.findById(tx, applicationId);
      if (application === undefined) throw notFound('Application not found.');
      if (application.status !== 'active') {
        throw new BusinessRuleError('BR-056', 'This application is already closed.');
      }
      await repository.setStatus(tx, applicationId, 'withdrawn');
    });
  }

  /** The job's pinned form-template version, needed for the application row. */
  async #requireJobTemplate(
    tx: TxScope,
    jobId: string,
  ): Promise<{ formTemplateVersionId: string }> {
    const { repository } = this.#deps;
    const version = await repository.jobFormVersion(tx, jobId);
    if (version === undefined) throw notFound('Job not found.');
    return version;
  }

  /**
   * Turns the trigger's `check_violation` into the catalogued error.
   *
   * The trigger raises `application_cap_reached` with SQLSTATE 23514. Nothing
   * else in this insert raises that code, so matching on it is precise —
   * and it is matched on the *code*, not the message, because a message is
   * not an interface.
   */
  async #insertWithCapTranslation(
    tx: TxScope,
    input: Parameters<ApplicationsRepository['insert']>[1],
  ): Promise<{ id: string }> {
    try {
      return await this.#deps.repository.insert(tx, input);
    } catch (error) {
      if (isCapViolation(error)) {
        /* Not `conflict()`: that helper is deliberately restricted to the
           four 409 codes, and the cap is a 422 — the request was well formed
           and a rule refused it. */
        throw new AppError('ERR_APPLICATION_CAP_REACHED', {
          detail: 'This candidate already has the maximum number of active applications.',
        });
      }
      if (isUniqueViolation(error)) {
        throw conflict('ERR_DUPLICATE', 'This candidate already has an active application here.');
      }
      throw error;
    }
  }
}

/** The profile as it is now, plus what the applicant stated for this role. */
function toSnapshot(
  candidate: {
    fullName: string;
    email: string | null;
    phone: string | null;
    currentTitle: string | null;
    currentEmployer: string | null;
    totalExperienceYears: string | null;
    currentCtc: string | null;
    ctcCurrency: string | null;
    locationCity: string | null;
    educationLevel: string | null;
  },
  input: SubmitApplicationInput,
): ApplicationSnapshot {
  return {
    fullName: candidate.fullName,
    email: candidate.email,
    phone: candidate.phone,
    currentTitle: candidate.currentTitle,
    currentEmployer: candidate.currentEmployer,
    experienceYears: toNumber(candidate.totalExperienceYears),
    currentCtc: toNumber(candidate.currentCtc),
    expectedCtc: input.expectedCtc,
    noticePeriodDays: input.noticePeriodDays,
    ctcCurrency: candidate.ctcCurrency,
    location: candidate.locationCity,
    educationLevel: candidate.educationLevel,
  };
}

/**
 * The source snapshot moved to the new application, minus expected
 * compensation (D-033). A figure quoted for one role is not a figure quoted
 * for another, and carrying it forward invents a number the candidate never
 * gave.
 */
function carryForward(source: ApplicationRow): ApplicationSnapshot {
  return {
    fullName: source.snapshotFullName,
    email: source.snapshotEmail,
    phone: source.snapshotPhone,
    currentTitle: source.snapshotCurrentTitle,
    currentEmployer: source.snapshotCurrentEmployer,
    experienceYears: toNumber(source.snapshotExperienceYears),
    currentCtc: toNumber(source.snapshotCurrentCtc),
    expectedCtc: null,
    noticePeriodDays: source.snapshotNoticePeriodDays,
    ctcCurrency: source.snapshotCtcCurrency,
    location: source.snapshotLocation,
    educationLevel: source.snapshotEducationLevel,
  };
}

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function hasSqlState(error: unknown, code: string, constraintOrText?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === code) {
      if (constraintOrText === undefined) return true;
      /* Narrowed before stringifying: an unknown that is not a string would
         otherwise render as "[object Object]" and match nothing, silently. */
      const message = typeof candidate.message === 'string' ? candidate.message : '';
      return message.includes(constraintOrText);
    }
    current = candidate.cause;
  }
  return false;
}

function isCapViolation(error: unknown): boolean {
  return hasSqlState(error, '23514', 'application_cap_reached');
}

function isUniqueViolation(error: unknown): boolean {
  return hasSqlState(error, '23505');
}
