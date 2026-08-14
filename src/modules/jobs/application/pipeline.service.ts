import { conflict, notFound } from '../../../shared/errors/app-error.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type { JobScope } from '../infrastructure/job-scope.js';
import type { JobsRepository } from '../infrastructure/jobs.repository.js';
import type {
  PipelineRepository,
  SkillRow,
  StageRow,
  TeamMemberRow,
} from '../infrastructure/pipeline.repository.js';

/** Per-job pipeline, hiring team and skills (T-046, T-047, T-048). */

export interface PipelineServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: PipelineRepository;
  readonly jobs: JobsRepository;
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

export class PipelineService {
  readonly #deps: PipelineServiceDeps;

  constructor(deps: PipelineServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Every method resolves the job through the scope predicate first.
   *
   * A stage or team endpoint that trusted its `jobId` would be a way to read
   * and write the pipeline of a confidential job you cannot see — the id is
   * the only thing the caller supplies, and it is guessable in principle.
   */
  async #requireJob(
    tx: TxScope,
    companyId: CompanyId,
    scope: JobScope,
    jobId: string,
  ): Promise<void> {
    const job = await this.#deps.jobs.findById(tx, companyId, scope, jobId);
    if (job === undefined) throw notFound('Job not found.');
  }

  /* ---------------------------------------------------------- job stages -- */

  async listStages(companyId: CompanyId, scope: JobScope, jobId: string): Promise<StageRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, async (tx: TxScope) => {
      await this.#requireJob(tx, companyId, scope, jobId);
      return repository.listStages(tx, jobId);
    });
  }

  async addStage(
    companyId: CompanyId,
    scope: JobScope,
    jobId: string,
    input: { name: string; stageType: string; isTerminal: boolean },
  ): Promise<{ id: string }> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, async (tx: TxScope) => {
      await this.#requireJob(tx, companyId, scope, jobId);
      return repository.addStage(tx, companyId, jobId, input);
    });
  }

  async renameStage(
    companyId: CompanyId,
    scope: JobScope,
    jobId: string,
    stageId: string,
    name: string,
  ): Promise<void> {
    const { uow, repository } = this.#deps;
    await uow.withTenant(companyId, async (tx: TxScope) => {
      await this.#requireJob(tx, companyId, scope, jobId);
      if ((await repository.renameStage(tx, stageId, name)) !== 1) {
        throw notFound('Stage not found.');
      }
    });
  }

  async deleteStage(
    companyId: CompanyId,
    scope: JobScope,
    jobId: string,
    stageId: string,
  ): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      await this.#requireJob(tx, companyId, scope, jobId);
      try {
        if ((await repository.deleteStage(tx, stageId)) !== 1) throw notFound('Stage not found.');
      } catch (error) {
        /* Applications reference stages. Deleting one that still holds them is
           a 409 (08 §7) — the FK is what makes that detectable rather than a
           silent orphaning. */
        if (isForeignKeyViolation(error)) {
          throw conflict('ERR_CONFLICT', 'This stage still holds applications.');
        }
        throw error;
      }
    });
  }

  /**
   * Reorder is a **collection** action — the one documented exception to
   * "no actions on collections" (07 §2). Reordering is atomic across the set,
   * and N individual PATCHes cannot be made safe against the unique index.
   */
  async reorderStages(
    companyId: CompanyId,
    scope: JobScope,
    jobId: string,
    orderedStageIds: readonly string[],
  ): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      await this.#requireJob(tx, companyId, scope, jobId);

      const existing = await repository.listStages(tx, jobId);
      /* Every stage must appear exactly once. A partial list would leave the
         omitted stages parked at their shifted +1000 order — a pipeline that
         looks reordered and is quietly broken. */
      if (existing.length !== orderedStageIds.length) {
        throw conflict('ERR_CONFLICT', 'The reorder must list every stage exactly once.');
      }
      const known = new Set(existing.map((stage) => stage.id));
      if (orderedStageIds.some((id) => !known.has(id))) {
        throw notFound('Stage not found.');
      }
      if (new Set(orderedStageIds).size !== orderedStageIds.length) {
        throw conflict('ERR_CONFLICT', 'The reorder lists a stage more than once.');
      }

      await repository.reorderStages(tx, jobId, orderedStageIds);
    });
  }

  /* --------------------------------------------------------- hiring team -- */

  async listTeam(companyId: CompanyId, scope: JobScope, jobId: string): Promise<TeamMemberRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, async (tx: TxScope) => {
      await this.#requireJob(tx, companyId, scope, jobId);
      return repository.listTeam(tx, jobId);
    });
  }

  async addTeamMember(
    companyId: CompanyId,
    scope: JobScope,
    jobId: string,
    userId: UserId,
    teamRole: string,
    addedBy: UserId,
  ): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      await this.#requireJob(tx, companyId, scope, jobId);
      try {
        await repository.addTeamMember(tx, companyId, jobId, userId, teamRole, addedBy);
      } catch (error) {
        /* The composite FK rejects a user from another tenant (BR-008). */
        if (isForeignKeyViolation(error)) throw notFound('User not found.');
        throw error;
      }
    });
  }

  async removeTeamMember(
    companyId: CompanyId,
    scope: JobScope,
    jobId: string,
    userId: UserId,
  ): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      await this.#requireJob(tx, companyId, scope, jobId);
      if ((await repository.removeTeamMember(tx, jobId, userId)) !== 1) {
        throw notFound('Team member not found.');
      }
    });
  }

  /* --------------------------------------------------------------- skills -- */

  async listSkills(companyId: CompanyId): Promise<SkillRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.listSkills(tx));
  }

  async listJobSkills(
    companyId: CompanyId,
    scope: JobScope,
    jobId: string,
  ): Promise<Record<string, unknown>[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, async (tx: TxScope) => {
      await this.#requireJob(tx, companyId, scope, jobId);
      return repository.listJobSkills(tx, jobId);
    });
  }

  async removeJobSkill(
    companyId: CompanyId,
    scope: JobScope,
    jobId: string,
    skillId: string,
  ): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      await this.#requireJob(tx, companyId, scope, jobId);
      if ((await repository.removeJobSkill(tx, jobId, skillId)) !== 1) {
        throw notFound('Skill not found on this job.');
      }
    });
  }

  /* ------------------------------------------------------------ templates -- */

  async listTemplates(companyId: CompanyId): Promise<{ id: string; name: string }[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.listTemplates(tx));
  }
}
