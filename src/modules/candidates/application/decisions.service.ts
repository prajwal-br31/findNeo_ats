import { BusinessRuleError, conflict, notFound } from '../../../shared/errors/app-error.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type { ApplicationsRepository } from '../infrastructure/applications.repository.js';
import type {
  DecisionRow,
  DecisionReasonRow,
  DecisionsRepository,
} from '../infrastructure/decisions.repository.js';
import type { StageReader } from './stage-reader.js';

/**
 * Stage movement and its record (T-066, T-067).
 *
 * Every movement writes a `stage_decisions` row in the same transaction as
 * the movement itself. The history is not a log written alongside the change
 * — it *is* the change, and an advance that committed without its decision
 * row would be a pipeline position nobody can account for.
 */

export interface DecisionsServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: DecisionsRepository;
  readonly applications: ApplicationsRepository;
  readonly pipeline: StageReader;
}

export interface DecisionCommand {
  readonly applicationId: string;
  readonly toStageId?: string;
  readonly reasonKeys: readonly string[];
  readonly notes: string | null;
}

export class DecisionsService {
  readonly #deps: DecisionsServiceDeps;

  constructor(deps: DecisionsServiceDeps) {
    this.#deps = deps;
  }

  async history(companyId: CompanyId, applicationId: string): Promise<DecisionRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) =>
      repository.listForApplication(tx, applicationId),
    );
  }

  async reasons(companyId: CompanyId, decisionType: string): Promise<DecisionReasonRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.listReasons(tx, decisionType));
  }

  /**
   * Advance to a named stage (BR-063).
   *
   * The stage must belong to **this application's own job**. The composite FK
   * only reaches as far as the tenant, so a stage from a sibling job in the
   * same company would satisfy the database and be nonsense — this is the
   * check that catches it.
   */
  async advance(companyId: CompanyId, userId: UserId, command: DecisionCommand): Promise<void> {
    const { uow, repository, applications, pipeline } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const application = await requireActive(applications, tx, command.applicationId);

      const toStageId = command.toStageId;
      if (toStageId === undefined) {
        throw new BusinessRuleError('BR-063', 'A target stage is required to advance.');
      }

      const stages = await pipeline.listStages(tx, application.jobId);
      const target = stages.find((stage) => stage.id === toStageId);
      if (target === undefined) {
        throw conflict('ERR_INVALID_TRANSITION', 'That stage does not belong to this job.');
      }

      await applications.setStage(tx, command.applicationId, toStageId);

      /* A terminal stage that is not `rejected` is the hire path (BR-065).
         Recorded as `hire`, not `advance`, because the decision is what the
         audit trail is read for. */
      const isHire = target.isTerminal && target.stageType === 'hired';
      const decisionId = await repository.insert(tx, {
        companyId,
        applicationId: command.applicationId,
        fromStageId: application.currentStageId,
        toStageId,
        decision: isHire ? 'hire' : 'advance',
        decidedBy: userId,
        notes: command.notes,
      });

      if (isHire) {
        await applications.setStatus(tx, command.applicationId, 'hired');
        await repository.attachReasons(tx, companyId, decisionId.id, 'hire', command.reasonKeys);
      }
    });
  }

  /**
   * Reject (BR-064).
   *
   * **At least one reason is mandatory**, and it is enforced here rather than
   * by a NOT NULL because reasons are a join table — a rejection with an
   * empty reason set is structurally valid and semantically useless. The
   * attach happens in the same transaction, so a rejection cannot commit
   * without them.
   */
  async reject(companyId: CompanyId, userId: UserId, command: DecisionCommand): Promise<void> {
    const { uow, repository, applications } = this.#deps;

    if (command.reasonKeys.length === 0) {
      throw new BusinessRuleError('BR-064', 'A rejection requires at least one reason.');
    }

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const application = await requireActive(applications, tx, command.applicationId);

      const decision = await repository.insert(tx, {
        companyId,
        applicationId: command.applicationId,
        fromStageId: application.currentStageId,
        toStageId: null,
        decision: 'reject',
        decidedBy: userId,
        notes: command.notes,
      });

      const attached = await repository.attachReasons(
        tx,
        companyId,
        decision.id,
        'reject',
        command.reasonKeys,
      );
      /* Every key matched nothing: the client sent keys from another catalog,
         or inactive ones. Committing would produce the reasonless rejection
         BR-064 forbids, so the whole transaction goes back. */
      if (attached === 0) {
        throw new BusinessRuleError('BR-064', 'None of the supplied rejection reasons are valid.');
      }

      await applications.setStatus(tx, command.applicationId, 'rejected');
    });
  }

  /**
   * Hold.
   *
   * The application stays `active` and stays where it is — a hold is a note
   * about intent, not a state change. `hold` deliberately has no reason
   * catalog (06b §2).
   */
  async hold(companyId: CompanyId, userId: UserId, command: DecisionCommand): Promise<void> {
    const { uow, repository, applications } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const application = await requireActive(applications, tx, command.applicationId);

      await repository.insert(tx, {
        companyId,
        applicationId: command.applicationId,
        fromStageId: application.currentStageId,
        toStageId: application.currentStageId,
        decision: 'hold',
        decidedBy: userId,
        notes: command.notes,
      });
    });
  }
}

/**
 * A decision only applies to a live application. Rejecting an already-rejected
 * one, or advancing a withdrawn one, is a stale client acting on a stale view.
 */
async function requireActive(
  applications: ApplicationsRepository,
  tx: TxScope,
  applicationId: string,
): Promise<{ jobId: string; currentStageId: string | null }> {
  const application = await applications.findById(tx, applicationId);
  if (application === undefined) throw notFound('Application not found.');
  if (application.status !== 'active') {
    throw conflict('ERR_INVALID_TRANSITION', 'This application is already closed.');
  }
  return { jobId: application.jobId, currentStageId: application.currentStageId };
}
