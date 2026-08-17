import type { StoragePort } from '../../../shared/ports/storage.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId } from '../../../shared/types/ids.js';
import type { ResumesRepository } from '../infrastructure/resumes.repository.js';
import { applicationResumeKey, extensionOf } from '../resume-content.js';

/**
 * Freezes a resume against an application (T-065, BR-060, D-011).
 *
 * **The object is copied, never referenced.** A later profile upload writes a
 * new object at a new key; because this copy lives at its own key, what a
 * hiring team evaluated stays byte-identical forever. Referencing the profile
 * object instead would make every past application silently change the moment
 * a candidate uploads a new CV — precisely the failure BR-060 exists to
 * prevent.
 *
 * Lives in the application layer rather than in the worker file because a
 * worker may not touch a repository or the database client (ER-011, ER-043).
 * The handler binds tenant context and calls this.
 *
 * **Idempotent** (ER-041): delivery is at-least-once, and
 * `ux_resume_per_application` permits exactly one row per application, so a
 * redelivery must find the existing row and stop rather than collide.
 */

export interface ResumeCopyServiceDeps {
  readonly repository: ResumesRepository;
  readonly storage: StoragePort;
}

export class ResumeCopyService {
  readonly #deps: ResumeCopyServiceDeps;

  constructor(deps: ResumeCopyServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Runs inside the worker's already-bound transaction.
   *
   * Returns quietly in two cases that are states rather than faults: the copy
   * already exists (a redelivery), and the source resume is gone (deleted
   * between submission and this job running). Throwing on either would
   * dead-letter a job that has nothing left to do.
   */
  async copyForApplication(
    tx: TxScope,
    companyId: CompanyId,
    applicationId: string,
    sourceResumeId: string,
  ): Promise<void> {
    const { repository, storage } = this.#deps;

    const existing = await repository.findForApplication(tx, applicationId);
    if (existing !== undefined) return;

    const source = await repository.findById(tx, sourceResumeId);
    if (source === undefined || source.applicationId !== null) return;

    /* The id is minted first so the destination key can carry it, exactly as
       the upload path does. */
    const copyId = await repository.nextId(tx);
    const destination = applicationResumeKey(
      companyId,
      applicationId,
      copyId,
      extensionOf(source.storageKey),
    );

    /* Server-side where the adapter supports it — the bytes never travel
       through this process. */
    await storage.copy(source.storageKey, destination);

    await repository.insert(tx, {
      companyId,
      candidateId: source.candidateId,
      applicationId,
      storageKey: destination,
      originalFilename: source.originalFilename,
      contentType: source.contentType,
      sizeBytes: source.sizeBytes,
      /* Carried over unchanged. It is the source's digest, and a copy that
         does not match it is a corrupt copy — which is what makes storing
         this column worth more than recomputing it on read. */
      checksumSha256: source.checksumSha256,
      uploadedBy: null,
      isCurrent: false,
    });
  }
}
