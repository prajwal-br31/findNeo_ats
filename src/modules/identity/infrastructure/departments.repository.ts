import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

/** Department persistence (T-031, 06 §3). */

export interface DepartmentRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly headUserId: string | null;
  readonly status: string;
  readonly memberCount: number;
}

export class DepartmentsRepository {
  async list(tx: TxScope): Promise<DepartmentRow[]> {
    const result = await unwrapTxScope(tx).execute<DepartmentRow>(sql`
      select d.id, d.name, d.head_user_id as "headUserId", d.status,
             (select count(*)::int from user_departments ud where ud.department_id = d.id)
               as "memberCount"
        from departments d
       order by d.name
    `);
    return result.rows;
  }

  async findById(tx: TxScope, id: string): Promise<DepartmentRow | undefined> {
    const result = await unwrapTxScope(tx).execute<DepartmentRow>(sql`
      select d.id, d.name, d.head_user_id as "headUserId", d.status,
             (select count(*)::int from user_departments ud where ud.department_id = d.id)
               as "memberCount"
        from departments d
       where d.id = ${id}
    `);
    return result.rows[0];
  }

  async create(tx: TxScope, companyId: CompanyId, name: string): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into departments (company_id, name) values (${companyId}, ${name}) returning id
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('department insert returned no row');
    return row;
  }

  async rename(tx: TxScope, id: string, name: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      update departments set name = ${name} where id = ${id}
    `);
    return result.rowCount ?? 0;
  }

  /**
   * Deletes only an empty department.
   *
   * The count is checked by the caller inside the same transaction rather than
   * relied on here, because "has members" is a business rule with its own
   * error code (ERR_CONFLICT, 08 §6) and a bare `delete` that affected zero
   * rows could not tell that apart from "does not exist".
   */
  async delete(tx: TxScope, id: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`delete from departments where id = ${id}`);
    return result.rowCount ?? 0;
  }

  async addMember(
    tx: TxScope,
    companyId: CompanyId,
    departmentId: string,
    userId: UserId,
  ): Promise<void> {
    /* The composite FKs on this table reject a user and a department from
       different tenants (BR-008). That pair would live legitimately inside the
       caller's own tenant, so RLS could not catch it — the constraint is the
       only thing standing between here and a cross-tenant membership. */
    await unwrapTxScope(tx).execute(sql`
      insert into user_departments (user_id, department_id, company_id)
      values (${userId}, ${departmentId}, ${companyId})
      on conflict (user_id, department_id) do nothing
    `);
  }

  async removeMember(tx: TxScope, departmentId: string, userId: UserId): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      delete from user_departments
       where department_id = ${departmentId} and user_id = ${userId}
    `);
    return result.rowCount ?? 0;
  }

  async members(tx: TxScope, departmentId: string): Promise<{ userId: string }[]> {
    const result = await unwrapTxScope(tx).execute<{ userId: string }>(sql`
      select user_id as "userId" from user_departments where department_id = ${departmentId}
    `);
    return result.rows;
  }
}
