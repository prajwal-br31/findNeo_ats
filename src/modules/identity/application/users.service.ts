import { notFound } from '../../../shared/errors/app-error.js';
import { decodeCursor, type CursorPayload } from '../../../shared/http/cursor.js';
import { paginate, resolveLimit, type Collection } from '../../../shared/http/envelope.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type {
  CurrentUserRow,
  UserDepartmentRow,
  UserListRow,
  UsersRepository,
} from '../infrastructure/users.repository.js';
import type { PermissionsService } from './permissions.service.js';

/**
 * The caller's own profile, and the tenant's user list.
 *
 * `GET /v1/users/current` is what the client boots from: nav, route guards and
 * every conditional control read its `permissions`.
 *
 * **Resolving permissions here does not contradict SEC-013.** That rule keeps
 * them out of the *token*, where a revocation would not take effect until the
 * token expired. This resolves fresh on every call, through the same
 * `PermissionsService` the authorization hook uses — so a role revoked a
 * second ago is already gone from the next response.
 */

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly status: string;
  readonly mfaEnabled: boolean;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly departments: readonly UserDepartmentRow[];
  /** 1 = organisation view, 2 = agency view (D-035). */
  readonly capability: number;
}

export interface UsersServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: UsersRepository;
  readonly permissions: PermissionsService;
}

export class UsersService {
  readonly #deps: UsersServiceDeps;

  constructor(deps: UsersServiceDeps) {
    this.#deps = deps;
  }

  async current(companyId: CompanyId, userId: UserId, capability: number): Promise<CurrentUser> {
    const { uow, repository, permissions } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const profile: CurrentUserRow | undefined = await repository.findCurrent(tx, userId);
      /* A valid token for a user RLS cannot see means the account was moved or
         deleted mid-session. 404 rather than 500 — there is no such user *for
         this caller*, which is exactly what the status means. */
      if (profile === undefined) throw notFound('User not found.');

      /* Resolved in the same transaction as the profile, so the permissions
         returned and the row they describe come from one snapshot. */
      const resolved = await permissions.resolveIn(tx, companyId, userId);

      return {
        id: profile.id,
        email: profile.email,
        fullName: profile.fullName,
        companyId: profile.companyId,
        companyName: profile.companyName,
        status: profile.status,
        mfaEnabled: profile.mfaEnabled,
        roles: await repository.roleKeysFor(tx, userId),
        permissions: [...resolved.keys].sort(),
        departments: await repository.departmentsFor(tx, userId),
        capability,
      };
    });
  }

  /**
   * One page of the tenant's users.
   *
   * Tenant-scoped by RLS — there is no `where company_id` here, because adding
   * one would look like the control and quietly become the only one.
   */
  async list(
    companyId: CompanyId,
    query: { limit?: number; cursor?: string },
  ): Promise<Collection<UserListRow>> {
    const { uow, repository } = this.#deps;
    const limit = resolveLimit(query.limit);
    const after: CursorPayload | undefined =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const rows = await repository.list(tx, limit, after);
      return paginate(rows, limit, (row) => ({
        sortValue: toIso(row.createdAt),
        id: row.id,
      }));
    });
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
