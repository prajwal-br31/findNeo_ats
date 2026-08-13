import type { CompanyId } from '../../shared/types/ids.js';

/**
 * The two-tenant fixture (11 §2, D-048b).
 *
 * Every suite gets two unrelated companies by default, because two tenants is
 * what makes the absence of a leak test obvious. `beta` exists to be the
 * control for every assertion made about `alpha`.
 *
 * **The body lands in T-020a, with Phase 1's migrations.** The tables it needs
 * — companies, users, departments, roles — do not exist until migrations
 * 002–012.
 */

export interface SeededTenant {
  readonly companyId: CompanyId;
  readonly slug: string;
}

export interface TwoTenants {
  /** The company under test. */
  readonly alpha: SeededTenant;
  /** An unrelated company. The control for every leak assertion. */
  readonly beta: SeededTenant;
}

/**
 * @throws always, until T-020a.
 *
 * It throws rather than returning empty tenants deliberately. A fixture that
 * silently seeds nothing makes every cross-tenant leak test pass vacuously:
 * alpha cannot read beta's data when beta has no data, so the suite goes green
 * while proving nothing at all. A red test that says "not implemented" is
 * worth more than a green one that says nothing — and ER-054 makes the leak
 * test the thing that decides whether a feature is done.
 */
export function seedTwoTenants(): Promise<TwoTenants> {
  throw new Error(
    'seedTwoTenants is not implemented until T-020a (D-048b). It needs companies, users, ' +
      'departments and roles, which arrive with Phase 1 migrations 002-012. It throws rather ' +
      'than returning empty tenants because a fixture that seeds nothing makes every ' +
      'cross-tenant leak test pass vacuously.',
  );
}
