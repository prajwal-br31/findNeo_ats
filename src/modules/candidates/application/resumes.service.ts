import { AppError, BusinessRuleError, notFound } from '../../../shared/errors/app-error.js';
import type { StoragePort } from '../../../shared/ports/storage.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type { CandidatesRepository } from '../infrastructure/candidates.repository.js';
import type { ResumeRow, ResumesRepository } from '../infrastructure/resumes.repository.js';
import {
  detectResumeContentType,
  MAX_RESUME_BYTES,
  resumeStorageKey,
  UnsupportedResumeError,
} from '../resume-content.js';

/**
 * Resume upload (T-064).
 *
 * Three things are decided here rather than trusted:
 *
 *  - **the content type**, from magic bytes, never from the client header;
 *  - **the storage key**, generated from ids, never from the filename; and
 *  - **the size**, checked before the bytes reach storage.
 *
 * The database write and the object write are ordered so a failure leaves no
 * dangling row: the object goes first, then the row that points at it. The
 * reverse order can commit a row referencing an object that was never
 * written, which reads as corruption. An orphaned object is merely waste.
 */

export interface ResumesServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: ResumesRepository;
  readonly candidates: CandidatesRepository;
  readonly storage: StoragePort;
  /** Injected so the application layer never imports `node:crypto` (ER-011). */
  readonly checksum: (bytes: Buffer) => string;
}

export interface UploadResumeInput {
  readonly candidateId: string;
  readonly bytes: Buffer;
  readonly originalFilename: string;
}

export class ResumesService {
  readonly #deps: ResumesServiceDeps;

  constructor(deps: ResumesServiceDeps) {
    this.#deps = deps;
  }

  async listForCandidate(companyId: CompanyId, candidateId: string): Promise<ResumeRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.listForCandidate(tx, candidateId));
  }

  /**
   * Uploads a new profile-level resume and makes it current.
   *
   * The previous current resume is demoted, not deleted: an application that
   * froze a copy of it still needs its own row, and the profile history is
   * worth keeping.
   */
  async upload(
    companyId: CompanyId,
    userId: UserId,
    input: UploadResumeInput,
  ): Promise<{ id: string; contentType: string }> {
    const { uow, repository, candidates, storage, checksum } = this.#deps;

    if (input.bytes.length === 0) {
      throw new BusinessRuleError('BR-060', 'The uploaded file is empty.');
    }
    if (input.bytes.length > MAX_RESUME_BYTES) {
      throw new AppError('ERR_PAYLOAD_TOO_LARGE', {
        detail: 'A resume may be at most 10 MB.',
      });
    }

    const detected = detect(input.bytes);
    const digest = checksum(input.bytes);

    /* Ids and the key are minted inside the transaction so the key can carry
       the resume id, but the object is written before the row commits. */
    return uow.withTenant(companyId, async (tx: TxScope) => {
      const candidate = await candidates.findById(tx, input.candidateId);
      if (candidate === undefined) throw notFound('Candidate not found.');

      const resumeId = await repository.nextId(tx);
      const key = resumeStorageKey(companyId, input.candidateId, resumeId, detected.extension);

      await storage.put(key, input.bytes, detected.contentType);

      await repository.clearCurrent(tx, input.candidateId);
      await repository.insert(tx, {
        companyId,
        candidateId: input.candidateId,
        applicationId: null,
        storageKey: key,
        originalFilename: input.originalFilename,
        contentType: detected.contentType,
        sizeBytes: input.bytes.length,
        checksumSha256: digest,
        uploadedBy: userId,
        isCurrent: true,
      });

      await candidates.setCurrentResume(tx, input.candidateId, resumeId);
      return { id: resumeId, contentType: detected.contentType };
    });
  }

  /**
   * The bytes of one resume, for download.
   *
   * Reads the row first: the row is what RLS protects. Fetching from storage
   * by a key the caller supplied would bypass tenancy entirely, which is why
   * this takes a resume id and never a key.
   */
  async download(
    companyId: CompanyId,
    resumeId: string,
  ): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    const { uow, repository, storage } = this.#deps;

    const row = await uow.withTenant(companyId, async (tx: TxScope) => {
      const found = await repository.findById(tx, resumeId);
      if (found === undefined) throw notFound('Resume not found.');
      return found;
    });

    return {
      bytes: await storage.get(row.storageKey),
      contentType: row.contentType,
      filename: row.originalFilename,
    };
  }
}

/** Translates the detector's own error into the API's vocabulary. */
function detect(bytes: Buffer): { contentType: string; extension: string } {
  try {
    return detectResumeContentType(bytes);
  } catch (error) {
    if (error instanceof UnsupportedResumeError) {
      throw new AppError('ERR_UNSUPPORTED_MEDIA_TYPE', { detail: error.message });
    }
    throw error;
  }
}
