import { notFound } from '../../../shared/errors/app-error.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type { PoolEntryRow, PoolRepository } from '../infrastructure/pool.repository.js';

/**
 * The talent pool (T-063, D-010).
 *
 * Membership and provenance, nothing else. An org cannot see an agency's pool
 * and vice versa, and that is ordinary tenant RLS on `owner_company_id` —
 * there is no special-case logic in this file, deliberately. The isolation
 * test names the table explicitly because the column is named differently
 * from every other tenant column in the schema.
 */

const DEFAULT_PAGE = 100;

export interface PoolServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: PoolRepository;
}

export interface AddToPoolCommand {
  readonly candidateId: string;
  readonly source: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
}

export class PoolService {
  readonly #deps: PoolServiceDeps;

  constructor(deps: PoolServiceDeps) {
    this.#deps = deps;
  }

  async list(companyId: CompanyId, status?: string): Promise<PoolEntryRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.list(tx, status, DEFAULT_PAGE));
  }

  async add(
    companyId: CompanyId,
    userId: UserId,
    command: AddToPoolCommand,
  ): Promise<{ id: string }> {
    const { uow, repository } = this.#deps;

    return uow.withTenant(companyId, (tx: TxScope) =>
      repository.add(tx, {
        ownerCompanyId: companyId,
        candidateId: command.candidateId,
        source: command.source,
        notes: command.notes,
        tags: command.tags,
        addedBy: userId,
      }),
    );
  }

  async setStatus(companyId: CompanyId, id: string, status: string): Promise<void> {
    const { uow, repository } = this.#deps;
    await uow.withTenant(companyId, async (tx: TxScope) => {
      const updated = await repository.setStatus(tx, id, status);
      if (!updated) throw notFound('Pool entry not found.');
    });
  }

  /**
   * Removes the membership, not the candidate.
   *
   * The candidate row survives — they may have applications, and a pool is a
   * shortlist rather than a store of people.
   */
  async remove(companyId: CompanyId, id: string): Promise<void> {
    const { uow, repository } = this.#deps;
    await uow.withTenant(companyId, async (tx: TxScope) => {
      const removed = await repository.remove(tx, id);
      if (!removed) throw notFound('Pool entry not found.');
    });
  }
}
