import type { DepartmentsService } from '../../modules/identity/application/departments.service.js';
import type {
  CurrentUser,
  UsersService,
} from '../../modules/identity/application/users.service.js';
import type { ResolvedPermissions } from '../../shared/authz/permission-cache.js';
import type { CompanyId, UserId } from '../../shared/types/ids.js';

/**
 * T-013b — the web BFF's one aggregation: everything the client needs to boot.
 *
 * **This adapts, it does not decide** (AGENTS.md §3.16, ER-002a). It calls
 * application services and reshapes what they return. There is no query here,
 * no repository, no entity, and no rule about what anything means.
 *
 * The client previously made two calls on every cold start — the profile, then
 * the department list — and could render neither until both landed. That is a
 * client-shaped problem, which is exactly what a BFF is for; solving it by
 * widening `GET /v1/users/current` would push a client concern into the
 * versioned API that every other consumer would then carry.
 *
 * **`departments` is `null`, not `[]`, when the caller may not read them.**
 * The distinction matters to a client deciding whether to render an empty
 * state or hide a section, and collapsing the two would make "no departments
 * exist" indistinguishable from "not for your eyes".
 */

export interface WebBootstrap {
  readonly user: CurrentUser;
  /** `null` means the caller lacks `departments.read`, not that there are none. */
  readonly departments: readonly { id: string; name: string; memberCount: number }[] | null;
}

export interface BootstrapAssemblerDeps {
  readonly users: UsersService;
  readonly departments: DepartmentsService;
}

export class BootstrapAssembler {
  readonly #deps: BootstrapAssemblerDeps;

  constructor(deps: BootstrapAssemblerDeps) {
    this.#deps = deps;
  }

  async assemble(
    companyId: CompanyId,
    userId: UserId,
    capability: number,
    permissions: ResolvedPermissions,
  ): Promise<WebBootstrap> {
    const { users, departments } = this.#deps;

    /* The profile first and on its own: it is the one part with no permission
       attached, so a caller holding nothing still boots into a usable shell
       rather than a blank page. */
    const user = await users.current(companyId, userId, capability);

    /* Reading a decision the authorization hook already made — not making one.
       The rule that `departments.read` governs this list lives in the route
       metadata of `/v1/departments`; this only honours it so the aggregate
       cannot become a way around it. */
    if (!permissions.keys.has('departments.read')) {
      return { user, departments: null };
    }

    const rows = await departments.list(companyId);
    return {
      user,
      departments: rows.map((row) => ({
        id: row.id,
        name: row.name,
        memberCount: row.memberCount,
      })),
    };
  }
}
