import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

/**
 * Invitation persistence (ER-005, ER-008).
 *
 * Every read here is tenant-scoped by RLS except `findByTokenHash`, which is
 * reached from an unauthenticated route and is documented where it sits.
 */

export interface InvitationRow extends Record<string, unknown> {
  readonly id: string;
  readonly email: string;
  readonly roleId: string;
  readonly roleKey: string;
  readonly departmentId: string | null;
  readonly status: string;
  readonly expiresAt: Date | string;
  readonly createdAt: Date | string;
}

export interface CreateInvitationInput {
  readonly companyId: CompanyId;
  readonly email: string;
  readonly roleId: string;
  readonly departmentId: string | null;
  readonly invitedBy: UserId;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export class InvitationsRepository {
  async create(tx: TxScope, input: CreateInvitationInput): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into invitations (company_id, email, role_id, department_id, invited_by,
                               token_hash, expires_at)
      values (${input.companyId}, ${input.email}, ${input.roleId}, ${input.departmentId},
              ${input.invitedBy}, ${input.tokenHash}, ${input.expiresAt})
      returning id
    `);

    const row = result.rows[0];
    if (row === undefined) throw new Error('invitation insert returned no row');
    return row;
  }

  /**
   * Lists the tenant's invitations. RLS scopes this to the bound company, so
   * there is no `where company_id` here — adding one would look like the
   * control and quietly become the only one.
   */
  async list(tx: TxScope): Promise<InvitationRow[]> {
    const result = await unwrapTxScope(tx).execute<InvitationRow>(sql`
      select i.id, i.email, i.role_id as "roleId", r.key as "roleKey",
             i.department_id as "departmentId", i.status,
             i.expires_at as "expiresAt", i.created_at as "createdAt"
        from invitations i
        join roles r on r.id = i.role_id
       order by i.created_at desc
    `);
    return result.rows;
  }

  async findById(tx: TxScope, id: string): Promise<InvitationRow | undefined> {
    const result = await unwrapTxScope(tx).execute<InvitationRow>(sql`
      select i.id, i.email, i.role_id as "roleId", r.key as "roleKey",
             i.department_id as "departmentId", i.status,
             i.expires_at as "expiresAt", i.created_at as "createdAt"
        from invitations i
        join roles r on r.id = i.role_id
       where i.id = ${id}
    `);
    return result.rows[0];
  }

  /**
   * Resolves an invitation from its token hash, with no tenant bound.
   *
   * The accept and preview routes are unauthenticated by necessity — the
   * invitee has no account yet — so this runs through a SECURITY DEFINER
   * function for the same reason login's lookup does: `invitations` is under
   * FORCE RLS and an untenanted select matches nothing.
   *
   * It returns the company id so the caller can bind context and do everything
   * else under the tenant's own policies. That is the only thing it hands out
   * that the caller could not already compute from the token.
   */
  async findByTokenHash(
    tx: TxScope,
    tokenHash: string,
  ): Promise<
    | {
        id: string;
        companyId: string;
        email: string;
        roleId: string;
        departmentId: string | null;
        status: string;
        expiresAt: Date | string;
        companyName: string;
      }
    | undefined
  > {
    const result = await unwrapTxScope(tx).execute<{
      id: string;
      companyId: string;
      email: string;
      roleId: string;
      departmentId: string | null;
      status: string;
      expiresAt: Date | string;
      companyName: string;
    }>(sql`
      select id, company_id as "companyId", email, role_id as "roleId",
             department_id as "departmentId", status, expires_at as "expiresAt",
             company_name as "companyName"
        from invitation_lookup_by_token(${tokenHash})
    `);
    return result.rows[0];
  }

  /**
   * Marks an invitation accepted, but only from `pending`.
   *
   * The `status = 'pending'` predicate is the concurrency control: two
   * simultaneous accepts of one token both pass the read, and exactly one
   * updates a row. The caller treats `0` as "already used".
   */
  async markAccepted(tx: TxScope, id: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      update invitations set status = 'accepted', accepted_at = now()
       where id = ${id} and status = 'pending'
    `);
    return result.rowCount ?? 0;
  }

  async markRevoked(tx: TxScope, id: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      update invitations set status = 'revoked'
       where id = ${id} and status = 'pending'
    `);
    return result.rowCount ?? 0;
  }

  /** Replaces the token on a resend, so the previous link stops working. */
  async replaceToken(tx: TxScope, id: string, tokenHash: string, expiresAt: Date): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      update invitations set token_hash = ${tokenHash}, expires_at = ${expiresAt}
       where id = ${id} and status = 'pending'
    `);
    return result.rowCount ?? 0;
  }

  async findRoleIdByKey(tx: TxScope, roleKey: string): Promise<string | undefined> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      select id from roles
       where key = ${roleKey}
         and (company_id is null
              or company_id = nullif(current_setting('app.current_company_id', true), '')::uuid)
       order by company_id nulls last
       limit 1
    `);
    return result.rows[0]?.id;
  }

  async companyName(tx: TxScope, companyId: CompanyId): Promise<string> {
    const result = await unwrapTxScope(tx).execute<{ name: string }>(sql`
      select name from companies where id = ${companyId}
    `);
    return result.rows[0]?.name ?? '';
  }
}
