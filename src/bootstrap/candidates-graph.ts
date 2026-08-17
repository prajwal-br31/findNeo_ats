import { PgBossQueue } from '../platform/queue/pg-boss-queue.js';
import { sha256Hex } from '../platform/crypto/checksum.js';
import type { UnitOfWorkHandle } from '../platform/db/unit-of-work.js';
import { ApplicationsService } from '../modules/candidates/application/applications.service.js';
import { CandidatesService } from '../modules/candidates/application/candidates.service.js';
import { DecisionsService } from '../modules/candidates/application/decisions.service.js';
import { PoolService } from '../modules/candidates/application/pool.service.js';
import { ResumeCopyService } from '../modules/candidates/application/resume-copy.service.js';
import { ResumesService } from '../modules/candidates/application/resumes.service.js';
import { CandidatesController } from '../modules/candidates/candidates.controller.js';
import { ApplicationsRepository } from '../modules/candidates/infrastructure/applications.repository.js';
import { CandidatesRepository } from '../modules/candidates/infrastructure/candidates.repository.js';
import { DecisionsRepository } from '../modules/candidates/infrastructure/decisions.repository.js';
import { PoolRepository } from '../modules/candidates/infrastructure/pool.repository.js';
import { ResumesRepository } from '../modules/candidates/infrastructure/resumes.repository.js';
import { PipelineRepository } from '../modules/jobs/infrastructure/pipeline.repository.js';
import type { StoragePort } from '../shared/ports/storage.js';

/**
 * The candidates module's object graph (Phase 3).
 *
 * It reaches into the jobs module for `PipelineRepository` because stage
 * membership is a jobs concept: an application advances to a stage of its own
 * job's pipeline (BR-063), and duplicating that lookup here would give the
 * two modules separate ideas of what a pipeline is.
 */
export function buildCandidates(
  database: UnitOfWorkHandle,
  storage: StoragePort,
  queue: PgBossQueue,
): { controller: CandidatesController; resumeCopy: ResumeCopyService } {
  const candidatesRepository = new CandidatesRepository();
  const resumesRepository = new ResumesRepository();
  const applicationsRepository = new ApplicationsRepository();
  const pipelineRepository = new PipelineRepository();

  const controller = new CandidatesController({
    candidates: new CandidatesService({ uow: database.uow, repository: candidatesRepository }),
    pool: new PoolService({ uow: database.uow, repository: new PoolRepository() }),
    resumes: new ResumesService({
      uow: database.uow,
      repository: resumesRepository,
      candidates: candidatesRepository,
      storage,
      /* Injected rather than imported: hashing is a platform concern and the
         application layer may not reach for `node:crypto` (ER-011). */
      checksum: sha256Hex,
    }),
    applications: new ApplicationsService({
      uow: database.uow,
      repository: applicationsRepository,
      candidates: candidatesRepository,
      resumes: resumesRepository,
      pipeline: pipelineRepository,
      queue,
    }),
    decisions: new DecisionsService({
      uow: database.uow,
      repository: new DecisionsRepository(),
      applications: applicationsRepository,
      pipeline: pipelineRepository,
    }),
  });

  return {
    controller,
    resumeCopy: new ResumeCopyService({ repository: resumesRepository, storage }),
  };
}
