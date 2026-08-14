import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { CursorPayload } from '../../../shared/http/cursor.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { UserId } from '../../../shared/types/ids.js';

/**
 * User **reads** — the profile and the directory.
 *
 * Split from `IdentityRepository`, which owns the write paths (signup, login,
 * sessions, MFA) and had reached the file-length limit. The division is by
 * concern and not only by size: nothing here mutates, so every query is
 * plainly a projection and RLS is the only tenant control involved.
 */

export interface CurrentUserRow extends Record<string, unknown> {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly status: string;
  readonly mfaEnabled: boolean;
}

export interface UserDepartmentRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly isPrimary: boolean;
}

export interface UserListRow extends Record<string, unknown> {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly status: string;
  readonly lastLoginAt: Date | string | null;
  readonly createdAt: Date | string;
  readonly roleKeys: string[];
  readonly departmentNames: string[];
}

/**
 * Aggregated in the query rather than fetched per row — a page of 25 users is
 * otherwise 51 round trips. `distinct` on the role keys because a user holding
 * the same role through two grants should appear once.
 */
const LIST_COLUMNS = sql`
  u.id, u.email, u.full_name as "fullName", u.phone, u.status,
  u.last_login_at as "lastLoginAt", u.created_at as "createdAt",
  coalesce((select array_agg(distinct r.key order by r.key)
              from user_roles ur join roles r on r.id = ur.role_id
             where ur.user_id = u.id), '{}') as "roleKeys",
  coalesce((select array_agg(d.name order by d.name)
              from user_departments ud join departments d on d.id = ud.department_id
             where ud.user_id = u.id), '{}') as "departmentNames"
`;

export class UsersRepository {
  /**
   * The caller's own profile, with company name and department membership.
   *
   * Backs `GET /v1/users/current`. Tenant-scoped by RLS, and `companies` is
   * joined rather than read separately so the whole thing is one round trip on
   * a path every page load hits.
   */
  async findCurrent(tx: TxScope, userId: UserId): Promise<CurrentUserRow | undefined> {
    const result = await unwrapTxScope(tx).execute<CurrentUserRow>(sql`
      select u.id, u.email, u.full_name as "fullName", u.company_id as "companyId",
             c.name as "companyName", u.status, u.mfa_enabled as "mfaEnabled"
        from users u
        join companies c on c.id = u.company_id
       where u.id = ${userId}
    `);
    return result.rows[0];
  }

  /** The role keys a user holds. Keys, not ids — the client shows these. */
  async roleKeysFor(tx: TxScope, userId: UserId): Promise<string[]> {
    const result = await unwrapTxScope(tx).execute<{ key: string }>(sql`
      select distinct r.key from user_roles ur
        join roles r on r.id = ur.role_id
       where ur.user_id = ${userId}
       order by r.key
    `);
    return result.rows.map((row) => row.key);
  }

  async departmentsFor(tx: TxScope, userId: UserId): Promise<UserDepartmentRow[]> {
    const result = await unwrapTxScope(tx).execute<UserDepartmentRow>(sql`
      select d.id, d.name, ud.is_primary as "isPrimary"
        from user_departments ud
        join departments d on d.id = ud.department_id
       where ud.user_id = ${userId}
       order by d.name
    `);
    return result.rows;
  }

  /**
   * The tenant's users, one page at a time.
   *
   * Keyset pagination on `(created_at, id)` rather than OFFSET (07 §5): the id
   * breaks ties so the ordering is total, and a page cannot shift under a
   * concurrent insert the way an offset silently does.
   *
   * No `where company_id` — RLS scopes this, and a redundant predicate here
   * would read as the control and eventually become the only one.
   */
  async list(tx: TxScope, limit: number, after?: CursorPayload): Promise<UserListRow[]> {
    const client = unwrapTxScope(tx);
    /* `limit + 1`: the extra row answers `hasMore` without a count query, and
       `paginate` drops it before the response is built. */
    const fetchLimit = limit + 1;

    if (after === undefined) {
      const result = await client.execute<UserListRow>(sql`
        select ${LIST_COLUMNS} from users u
         order by u.created_at desc, u.id desc
         limit ${fetchLimit}
      `);
      return result.rows;
    }

    const result = await client.execute<UserListRow>(sql`
      select ${LIST_COLUMNS} from users u
       where (u.created_at, u.id) < (${after.sortValue}::timestamptz, ${after.id}::uuid)
       order by u.created_at desc, u.id desc
       limit ${fetchLimit}
    `);
    return result.rows;
  }
}
