/**
 * The database roles, and exactly one capability each.
 *
 * The isolation suite asserts every one of these against `pg_roles` rather
 * than trusting this file — a control that is only true in the provisioning
 * script is not a control (11 §3a).
 */

export const DEV_DATABASE = 'findneo_dev';
export const TEST_DATABASE = 'findneo_test';

/** Owns every table. Never serves traffic (06 §2). */
export const MIGRATOR_ROLE = 'findneo_migrator';

/** The three traffic roles, named in 06 §2. None owns anything. */
export const TRAFFIC_ROLES = ['findneo_app', 'findneo_public', 'findneo_platform'] as const;

/**
 * Test provisioning only (D-048a, 11 §2). Holds `CREATEDB` so the harness can
 * clone a template database per test, and **owns those clones outright** —
 * assigning ownership to another role would require membership in it, and
 * membership in `findneo_migrator` is the one thing that must never exist.
 *
 * `findneo_migrator` is `NOCREATEDB` by design. Unlike `BYPASSRLS`, which an
 * owner can grant itself by disabling `FORCE`, `CREATEDB` is not
 * self-grantable — so D-047(b)'s reasoning does not transfer, and this stays a
 * real capability boundary. The role must never exist in a production
 * provisioning path.
 */
export const TEST_RUNNER_ROLE = 'findneo_test_runner';

export type RoleName =
  typeof MIGRATOR_ROLE | typeof TEST_RUNNER_ROLE | (typeof TRAFFIC_ROLES)[number];

/** Roles that exist in every environment. */
export const ALL_ROLES: readonly RoleName[] = [MIGRATOR_ROLE, ...TRAFFIC_ROLES];

/** Everything the local development cluster needs, tests included. */
export const PROVISIONED_ROLES: readonly RoleName[] = [...ALL_ROLES, TEST_RUNNER_ROLE];

/**
 *   migrator    BYPASSRLS  — owner is subject to FORCE; seeds would be denied (D-047b)
 *   test runner CREATEDB   — clones a template per test; dev and CI only (D-048a)
 *   traffic     neither
 */
export function roleAttributes(role: RoleName): string {
  const base = 'LOGIN NOSUPERUSER NOCREATEROLE NOINHERIT';
  if (role === MIGRATOR_ROLE) return `${base} NOCREATEDB BYPASSRLS`;
  if (role === TEST_RUNNER_ROLE) return `${base} CREATEDB NOBYPASSRLS`;
  return `${base} NOCREATEDB NOBYPASSRLS`;
}
