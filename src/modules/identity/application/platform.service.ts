import { AppError, notFound } from '../../../shared/errors/app-error.js';
import type { ClockPort } from '../../../shared/ports/clock.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import { unsafeCompanyId, type CompanyId, type UserId } from '../../../shared/types/ids.js';
import type {
  ActiveGrantRow,
  CompanySummaryRow,
  PlatformRepository,
} from '../infrastructure/platform.repository.js';

/**
 * The platform-admin surface (T-033, D-005, BR-006, SEC-026).
 *
 * Platform staff hold **no tenant permission at all** (04 §3). Every column
 * outside the platform group is `○`. Tenant access requires an impersonation
 * grant: time-boxed, carrying a stated reason, and visible to the tenant's own
 * Super Admin.
 *
 * Without an active grant, platform staff get **404** on tenant data, never
 * 403 (SEC-026) — a 403 would confirm the company exists, which is exactly the
 * fact a platform account should not be able to fish for.
 */

/** 08 §3: default 60 minutes. */
export const DEFAULT_IMPERSONATION_MINUTES = 60;
export const MAX_IMPERSONATION_MINUTES = 240;

export interface PlatformServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: PlatformRepository;
  readonly clock: ClockPort;
}

export interface StartImpersonationInput {
  readonly companyId: string;
  readonly reason: string;
  readonly minutes?: number;
}

export class PlatformService {
  readonly #deps: PlatformServiceDeps;

  constructor(deps: PlatformServiceDeps) {
    this.#deps = deps;
  }

  async listCompanies(): Promise<CompanySummaryRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withoutTenant((tx: TxScope) => repository.listCompanies(tx));
  }

  /**
   * Opens a time-boxed grant and audits it into the target tenant.
   *
   * The audit row is written **inside the same transaction** as the grant, and
   * into the tenant's own `audit_logs`, which is what makes it visible to their
   * Super Admin (BR-006). Written afterwards, a crash between the two would
   * produce an impersonation nobody was told about — the one failure mode this
   * whole mechanism exists to prevent.
   */
  async startImpersonation(
    platformUserId: UserId,
    input: StartImpersonationInput,
    traceId: string,
  ): Promise<{ grantId: string; expiresAt: Date }> {
    const { uow, repository, clock } = this.#deps;

    const minutes = Math.min(
      input.minutes ?? DEFAULT_IMPERSONATION_MINUTES,
      MAX_IMPERSONATION_MINUTES,
    );

    /* The reason floor is also a CHECK on the column. Here so the caller gets
       a 422 rather than a constraint violation, there so nothing can write a
       grant around this service. */
    if (input.reason.trim().length < 10) {
      throw new AppError('ERR_VALIDATION_FAILED', {
        detail: 'A stated reason of at least 10 characters is required.',
      });
    }

    const companyId = unsafeCompanyId(input.companyId);

    return uow.withNewTenant(async (tx: TxScope, bind) => {
      const grantId = await repository.createGrant(
        tx,
        companyId,
        platformUserId,
        input.reason.trim(),
        minutes,
      );

      /* Bound after the grant is created, because the audit row is tenant
         data and needs the tenant's context to satisfy RLS — while the grant
         itself is written through a SECURITY DEFINER function precisely
         because no tenant is bound at that point. */
      await bind(companyId);
      await repository.writeAudit(
        tx,
        companyId,
        platformUserId,
        'impersonation.started',
        grantId,
        traceId,
      );

      return {
        grantId,
        expiresAt: new Date(clock.now().getTime() + minutes * 60_000),
      };
    });
  }

  async endImpersonation(platformUserId: UserId, grantId: string, traceId: string): Promise<void> {
    const { uow, repository } = this.#deps;

    const grant = await uow.withoutTenant((tx: TxScope) => repository.activeGrant(tx, grantId));
    /* 404 for an expired, ended or foreign grant alike. Distinguishing them
       tells a platform account which grant ids exist. */
    if (grant === undefined || grant.platformUserId !== platformUserId) {
      throw notFound('Impersonation grant not found.');
    }

    const companyId = unsafeCompanyId(grant.companyId);

    await uow.withNewTenant(async (tx: TxScope, bind) => {
      const ended = await repository.endGrant(tx, grantId, platformUserId);
      if (ended !== 1) throw notFound('Impersonation grant not found.');

      await bind(companyId);
      await repository.writeAudit(
        tx,
        companyId,
        platformUserId,
        'impersonation.ended',
        grantId,
        traceId,
      );
    });
  }

  /**
   * Resolves a grant into a tenant the staff member may act as.
   *
   * The authorization path calls this for a request carrying a grant id.
   * `undefined` means no access — and the caller must turn that into a 404,
   * not a 403.
   */
  async resolveGrant(platformUserId: UserId, grantId: string): Promise<CompanyId | undefined> {
    const { uow, repository } = this.#deps;

    const grant = await uow.withoutTenant((tx: TxScope) => repository.activeGrant(tx, grantId));
    if (grant === undefined || grant.platformUserId !== platformUserId) return undefined;
    return unsafeCompanyId(grant.companyId);
  }

  /** What the tenant's own Super Admin can see about impersonation (BR-006). */
  async grantsForCompany(companyId: CompanyId): Promise<ActiveGrantRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.grantsForCompany(tx));
  }
}
