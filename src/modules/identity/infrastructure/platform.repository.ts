import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

/** Platform-admin persistence (T-033, D-005, BR-006). */

export interface PlatformUserRow extends Record<string, unknown> {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly status: string;
  readonly mfaEnabled: boolean;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | string | null;
}

export interface CompanySummaryRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly createdAt: Date | string;
}

export interface ActiveGrantRow extends Record<string, unknown> {
  readonly id: string;
  readonly companyId: string;
  readonly platformUserId: string;
  readonly expiresAt: Date | string;
}

export class PlatformRepository {
  /** Mirror of the tenant login lookup — this one returns only staff. */
  async findStaffByEmail(tx: TxScope, email: string): Promise<PlatformUserRow | undefined> {
    const result = await unwrapTxScope(tx).execute<PlatformUserRow>(sql`
      select id, email, password_hash as "passwordHash", status,
             mfa_enabled as "mfaEnabled", failed_login_count as "failedLoginCount",
             locked_until as "lockedUntil"
        from platform_lookup_user_by_email(${email}::citext)
    `);
    return result.rows[0];
  }

  /**
   * Tenant administration: names and status, never tenant data.
   *
   * Runs untenanted and reads `companies` directly, which RLS would normally
   * hide. It works because platform staff sessions carry `cid: null` and this
   * runs as the migrator-owned function path... it does not. It reads through
   * the app role, so RLS applies and this returns **zero rows**.
   *
   * That is deliberate and it is the point of D-005: there is no ambient
   * platform read of tenant tables. A real tenant-administration list needs
   * its own SECURITY DEFINER projection returning non-tenant columns only, and
   * that is not in this slice — the endpoint exists, and it returns what the
   * policy permits, which is nothing until such a projection is added.
   */
  async listCompanies(tx: TxScope): Promise<CompanySummaryRow[]> {
    const result = await unwrapTxScope(tx).execute<CompanySummaryRow>(sql`
      select id, name, slug, status, created_at as "createdAt"
        from companies order by created_at desc limit 100
    `);
    return result.rows;
  }

  async createGrant(
    tx: TxScope,
    companyId: CompanyId,
    platformUserId: UserId,
    reason: string,
    minutes: number,
  ): Promise<string> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      select impersonation_grant_create(${companyId}, ${platformUserId}, ${reason}, ${minutes})
        as id
    `);
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('impersonation grant returned no id');
    return id;
  }

  /** Undefined when the grant is ended, expired, or was never real. */
  async activeGrant(tx: TxScope, grantId: string): Promise<ActiveGrantRow | undefined> {
    const result = await unwrapTxScope(tx).execute<ActiveGrantRow>(sql`
      select id, company_id as "companyId", platform_user_id as "platformUserId",
             expires_at as "expiresAt"
        from impersonation_grant_active(${grantId})
    `);
    return result.rows[0];
  }

  async endGrant(tx: TxScope, grantId: string, platformUserId: UserId): Promise<number> {
    const result = await unwrapTxScope(tx).execute<{ count: number }>(sql`
      select impersonation_grant_end(${grantId}, ${platformUserId}) as count
    `);
    return result.rows[0]?.count ?? 0;
  }

  /**
   * The grants against one tenant, for that tenant's Super Admin (BR-006).
   *
   * Tenant-scoped and read under the tenant's own context, so RLS is what
   * limits it — the company cannot see grants against anybody else.
   */
  async grantsForCompany(tx: TxScope): Promise<ActiveGrantRow[]> {
    const result = await unwrapTxScope(tx).execute<ActiveGrantRow>(sql`
      select id, company_id as "companyId", platform_user_id as "platformUserId",
             expires_at as "expiresAt"
        from impersonation_grants order by granted_at desc
    `);
    return result.rows;
  }

  /** Every request under a grant writes one of these (BR-006). */
  async writeAudit(
    tx: TxScope,
    companyId: CompanyId,
    actorUserId: UserId,
    action: string,
    entityId: string,
    traceId: string,
  ): Promise<void> {
    await unwrapTxScope(tx).execute(sql`
      insert into audit_logs (company_id, actor_user_id, actor_role_key, action,
                              entity_type, entity_id, trace_id)
      values (${companyId}, ${actorUserId}, 'system_admin', ${action},
              'impersonation_grant', ${entityId}, ${traceId})
    `);
  }
}
