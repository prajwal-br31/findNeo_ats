import { conflict, notFound } from '../../../shared/errors/app-error.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type {
  DepartmentRow,
  DepartmentsRepository,
} from '../infrastructure/departments.repository.js';

/** Departments and membership (T-031, 08 §5). */

export interface DepartmentsServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: DepartmentsRepository;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === constraint) return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * A foreign-key violation on `user_departments` means the composite FK
 * rejected a cross-tenant pair (BR-008) — the user and the department belong
 * to different companies. Reported as 404, matching what RLS would have said
 * if the row had been reachable at all.
 */
function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23503') return true;
    current = candidate.cause;
  }
  return false;
}

export class DepartmentsService {
  readonly #deps: DepartmentsServiceDeps;

  constructor(deps: DepartmentsServiceDeps) {
    this.#deps = deps;
  }

  async list(companyId: CompanyId): Promise<DepartmentRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.list(tx));
  }

  async create(companyId: CompanyId, name: string): Promise<{ id: string }> {
    const { uow, repository } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      try {
        return await repository.create(tx, companyId, name);
      } catch (error) {
        if (isUniqueViolation(error, 'uq_departments_company_name')) {
          throw conflict('ERR_DUPLICATE', 'A department with that name already exists.');
        }
        throw error;
      }
    });
  }

  async rename(companyId: CompanyId, id: string, name: string): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      try {
        /* RLS scopes the update, so zero rows means "not this tenant's" or
           "gone" — both 404 (SEC-026). */
        if ((await repository.rename(tx, id, name)) !== 1) {
          throw notFound('Department not found.');
        }
      } catch (error) {
        if (isUniqueViolation(error, 'uq_departments_company_name')) {
          throw conflict('ERR_DUPLICATE', 'A department with that name already exists.');
        }
        throw error;
      }
    });
  }

  /**
   * Deletes an empty department. One transaction (08 §5).
   *
   * The members check and the delete are in the same transaction because they
   * disagree otherwise: a member added between a separate check and a separate
   * delete would be silently removed by the FK cascade.
   */
  async delete(companyId: CompanyId, id: string): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const existing = await repository.findById(tx, id);
      if (existing === undefined) throw notFound('Department not found.');

      if (existing.memberCount > 0) {
        /* 409, not a cascade. `user_departments` cascades on delete, so this
           would otherwise quietly detach every member — and department
           membership is an access-scope input (04 §4), so silently dropping it
           widens what those people can see. */
        throw conflict('ERR_CONFLICT', 'Remove the department’s members before deleting it.');
      }

      await repository.delete(tx, id);
    });
  }

  async addMember(companyId: CompanyId, departmentId: string, userId: UserId): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const existing = await repository.findById(tx, departmentId);
      if (existing === undefined) throw notFound('Department not found.');

      try {
        await repository.addMember(tx, companyId, departmentId, userId);
      } catch (error) {
        if (isForeignKeyViolation(error)) throw notFound('Department not found.');
        throw error;
      }
    });
  }

  async removeMember(companyId: CompanyId, departmentId: string, userId: UserId): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const existing = await repository.findById(tx, departmentId);
      if (existing === undefined) throw notFound('Department not found.');
      if ((await repository.removeMember(tx, departmentId, userId)) !== 1) {
        throw notFound('Membership not found.');
      }
    });
  }
}
