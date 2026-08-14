import { conflict, forbidden, notFound } from '../../../shared/errors/app-error.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type {
  AssignmentRow,
  RoleRow,
  RolesRepository,
} from '../infrastructure/roles.repository.js';
import type { PermissionsService } from './permissions.service.js';

/**
 * Roles and assignment (T-032, 08 §4, BR-025).
 *
 * The escalation guard is the load-bearing part. Without it `roles.assign` is
 * effectively Super Admin: anyone who can grant roles can grant themselves the
 * role that grants everything.
 */

export interface RolesServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: RolesRepository;
  readonly permissions: PermissionsService;
}

export interface CreateRoleInput {
  readonly key: string;
  readonly name: string;
  readonly scope: string;
  readonly permissionKeys: readonly string[];
}

export interface AssignRoleInput {
  readonly roleId: string;
  readonly departmentId: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    current = candidate.cause;
  }
  return false;
}

export class RolesService {
  readonly #deps: RolesServiceDeps;

  constructor(deps: RolesServiceDeps) {
    this.#deps = deps;
  }

  async list(companyId: CompanyId): Promise<RoleRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.list(tx));
  }

  async listPermissions(companyId: CompanyId): Promise<{ key: string; category: string }[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.allPermissionKeys(tx));
  }

  /**
   * Creates a custom role.
   *
   * The escalation guard applies here too, and not only to assignment: a role
   * whose permission set exceeds the actor's is a role they can then grant to
   * themselves. Guarding assignment alone leaves the two-step version open.
   */
  async create(
    companyId: CompanyId,
    actorId: UserId,
    input: CreateRoleInput,
  ): Promise<{ id: string }> {
    const { uow, repository, permissions } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const actor = await permissions.resolveIn(tx, companyId, actorId);
      assertNoEscalation(actor.keys, input.permissionKeys);

      try {
        const role = await repository.create(tx, companyId, input);
        await repository.setPermissions(tx, role.id, input.permissionKeys);
        return role;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('ERR_DUPLICATE', 'A role with that key already exists.');
        }
        throw error;
      }
    });
  }

  async update(
    companyId: CompanyId,
    actorId: UserId,
    roleId: string,
    input: { name?: string; permissionKeys?: readonly string[] },
  ): Promise<void> {
    const { uow, repository, permissions } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const role = await repository.findById(tx, roleId);
      if (role === undefined) throw notFound('Role not found.');

      /* A platform default is readable by every company and editable by none
         (08 §6). Enforced here and by the `is_editable` predicate in the
         repository's UPDATE — the write policy stops a cross-tenant edit, this
         stops an in-tenant edit of a shared row. */
      if (!role.isEditable) throw forbidden('Platform-default roles cannot be edited.');

      if (input.permissionKeys !== undefined) {
        const actor = await permissions.resolveIn(tx, companyId, actorId);
        assertNoEscalation(actor.keys, input.permissionKeys);
        await repository.setPermissions(tx, roleId, input.permissionKeys);
      }

      if (input.name !== undefined) await repository.rename(tx, roleId, input.name);
    });
  }

  async delete(companyId: CompanyId, roleId: string): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const role = await repository.findById(tx, roleId);
      if (role === undefined) throw notFound('Role not found.');
      if (!role.isEditable) throw forbidden('Platform-default roles cannot be deleted.');
      await repository.delete(tx, roleId);
    });
  }

  async listAssignments(companyId: CompanyId, userId: UserId): Promise<AssignmentRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.listAssignments(tx, userId));
  }

  /**
   * Grants a role, guarded against escalation (BR-025) and bumping
   * `rolesVersion` (08 §5).
   *
   * The version bump is a database trigger on `user_roles` rather than a call
   * here — every path that changes an assignment has to bump it, including
   * ones that do not exist yet, and a trigger cannot be forgotten by the next
   * feature.
   */
  async assign(
    companyId: CompanyId,
    actorId: UserId,
    userId: UserId,
    input: AssignRoleInput,
  ): Promise<{ id: string }> {
    const { uow, repository, permissions } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const role = await repository.findById(tx, input.roleId);
      if (role === undefined) throw notFound('Role not found.');

      const actor = await permissions.resolveIn(tx, companyId, actorId);
      const granted = await repository.permissionKeys(tx, input.roleId);
      assertNoEscalation(actor.keys, granted);

      try {
        return await repository.assign(
          tx,
          companyId,
          userId,
          input.roleId,
          input.departmentId,
          actorId,
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('ERR_DUPLICATE', 'That role is already assigned.');
        }
        throw error;
      }
    });
  }

  async revoke(companyId: CompanyId, userId: UserId, assignmentId: string): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      if ((await repository.revokeAssignment(tx, userId, assignmentId)) !== 1) {
        throw notFound('Assignment not found.');
      }
    });
  }
}

/**
 * BR-025 — the actor's permission set must be a superset of what they grant.
 *
 * Without this, `roles.assign` is Super Admin by another name: an HR Admin
 * could grant themselves a role carrying `platform.support.impersonate`, or
 * simply hand out `roles.assign` plus everything else to a colleague.
 *
 * The check is on the *set*, not on the role's name, so it also catches the
 * two-step version — create a role with permissions you lack, then grant it.
 */
function assertNoEscalation(actorKeys: ReadonlySet<string>, granting: readonly string[]): void {
  const exceeded = granting.filter((key) => !actorKeys.has(key));
  if (exceeded.length === 0) return;

  /* The response names nothing. Listing which permissions were missing tells
     the caller precisely what they hold, which is a map of where to probe
     next. */
  throw forbidden('You cannot grant a permission you do not hold.');
}
