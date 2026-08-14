import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

/** Roles, permissions and assignments (T-032, 06 §4). */

export interface RoleRow extends Record<string, unknown> {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly scope: string;
  readonly isEditable: boolean;
  /** NULL for a platform default, readable by every company. */
  readonly companyId: string | null;
}

export interface AssignmentRow extends Record<string, unknown> {
  readonly id: string;
  readonly roleId: string;
  readonly roleKey: string;
  readonly departmentId: string | null;
  readonly createdAt: Date | string;
}

export class RolesRepository {
  /**
   * Every role this company can use: its own, plus the platform defaults.
   *
   * The `company_id IS NULL` half comes from migration 013's split read policy
   * on `roles` — the one documented deviation from the canonical policy. Write
   * policies stay strictly tenant-scoped, so a company can read a platform
   * default and never modify it.
   */
  async list(tx: TxScope): Promise<RoleRow[]> {
    const result = await unwrapTxScope(tx).execute<RoleRow>(sql`
      select id, key, name, scope, is_editable as "isEditable", company_id as "companyId"
        from roles
       order by company_id nulls first, key
    `);
    return result.rows;
  }

  async findById(tx: TxScope, id: string): Promise<RoleRow | undefined> {
    const result = await unwrapTxScope(tx).execute<RoleRow>(sql`
      select id, key, name, scope, is_editable as "isEditable", company_id as "companyId"
        from roles where id = ${id}
    `);
    return result.rows[0];
  }

  async create(
    tx: TxScope,
    companyId: CompanyId,
    input: { key: string; name: string; scope: string },
  ): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into roles (company_id, key, name, scope, is_editable)
      values (${companyId}, ${input.key}, ${input.name}, ${input.scope}, true)
      returning id
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('role insert returned no row');
    return row;
  }

  async rename(tx: TxScope, id: string, name: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      update roles set name = ${name} where id = ${id} and is_editable
    `);
    return result.rowCount ?? 0;
  }

  async delete(tx: TxScope, id: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      delete from roles where id = ${id} and is_editable
    `);
    return result.rowCount ?? 0;
  }

  /** The permission keys a role grants. */
  async permissionKeys(tx: TxScope, roleId: string): Promise<string[]> {
    const result = await unwrapTxScope(tx).execute<{ key: string }>(sql`
      select p.key from role_permissions rp
        join permissions p on p.id = rp.permission_id
       where rp.role_id = ${roleId}
       order by p.key
    `);
    return result.rows.map((row) => row.key);
  }

  /**
   * Replaces a custom role's permission set wholesale.
   *
   * The key list is expanded into one bind parameter per key rather than
   * passed as an array. `= any(${keys}::text[])` looks right and is not:
   * Drizzle serialises a JS array as a JSON-style `[a,b]`, and Postgres wants
   * the `{a,b}` array literal, so every call failed with `22P02`. `sql.join`
   * emits `$2, $3, …`, which is still fully parameterised — nothing is
   * interpolated into the statement (ER-031, SEC-042).
   */
  async setPermissions(tx: TxScope, roleId: string, keys: readonly string[]): Promise<void> {
    const client = unwrapTxScope(tx);
    await client.execute(sql`delete from role_permissions where role_id = ${roleId}`);
    if (keys.length === 0) return;

    const keyList = sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `,
    );

    await client.execute(sql`
      insert into role_permissions (role_id, permission_id)
      select ${roleId}, p.id from permissions p where p.key in (${keyList})
    `);
  }

  async listAssignments(tx: TxScope, userId: UserId): Promise<AssignmentRow[]> {
    const result = await unwrapTxScope(tx).execute<AssignmentRow>(sql`
      select ur.id, ur.role_id as "roleId", r.key as "roleKey",
             ur.department_id as "departmentId", ur.created_at as "createdAt"
        from user_roles ur
        join roles r on r.id = ur.role_id
       where ur.user_id = ${userId}
       order by ur.created_at
    `);
    return result.rows;
  }

  async assign(
    tx: TxScope,
    companyId: CompanyId,
    userId: UserId,
    roleId: string,
    departmentId: string | null,
    grantedBy: UserId,
  ): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into user_roles (company_id, user_id, role_id, department_id, granted_by)
      values (${companyId}, ${userId}, ${roleId}, ${departmentId}, ${grantedBy})
      returning id
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('assignment insert returned no row');
    return row;
  }

  async revokeAssignment(tx: TxScope, userId: UserId, assignmentId: string): Promise<number> {
    /* Scoped by user as well as id: an assignment id from another user is a
       404, not a successful revoke of somebody else's role. */
    const result = await unwrapTxScope(tx).execute(sql`
      delete from user_roles where id = ${assignmentId} and user_id = ${userId}
    `);
    return result.rowCount ?? 0;
  }

  async allPermissionKeys(tx: TxScope): Promise<{ key: string; category: string }[]> {
    const result = await unwrapTxScope(tx).execute<{ key: string; category: string }>(sql`
      select key, category from permissions order by category, key
    `);
    return result.rows;
  }
}
