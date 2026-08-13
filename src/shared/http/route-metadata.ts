/**
 * SEC-021 — fail closed at route registration.
 *
 * Every route declares **either** `permission` **or** `public: true` with a
 * `publicReason`. A route declaring neither does not fail at request time; it
 * fails at **boot**, so a forgotten permission breaks the build rather than
 * silently exposing an endpoint.
 *
 * Absence is never interpreted as public. The opt-out is explicit, greppable,
 * and small enough to review in full — and `countPublicRoutes` exists so CI
 * can assert the number against a committed expectation, making a new public
 * route something a human approves rather than something that appears.
 */

export interface PermissionedRoute {
  readonly permission: string;
  readonly public?: never;
  readonly publicReason?: never;
}

export interface PublicRoute {
  readonly public: true;
  /** Why this endpoint has no permission. Read in review; keep it short. */
  readonly publicReason: string;
  readonly permission?: never;
}

export type RouteMetadata = PermissionedRoute | PublicRoute;

/** Fastify carries this under `config.findneo` on every route. */
export interface RouteConfig {
  readonly findneo?: RouteMetadata;
}

/**
 * The one route this system does not own.
 *
 * `@fastify/cors` registers a wildcard `OPTIONS` handler for preflight. It is
 * not an application endpoint: it returns CORS headers and no body, it is
 * answered by the CORS layer before any handler, and its behaviour is governed
 * by the origin allowlist rather than by a permission.
 *
 * It is exempted **by name**, not by a path prefix, so the exemption cannot
 * quietly widen — a prefix rule like "skip anything under /docs" is how these
 * things grow. `exemptRoutes()` reports it so an audit sees it rather than
 * having to know it exists.
 */
export function isCorsPreflightRoute(method: string, url: string): boolean {
  return method === 'OPTIONS' && url === '*';
}

export class RouteRegistrationError extends Error {
  constructor(method: string, url: string, why: string) {
    super(`refusing to register ${method} ${url}: ${why}`);
    this.name = 'RouteRegistrationError';
  }
}

function isPublic(metadata: RouteMetadata): metadata is PublicRoute {
  return metadata.public === true;
}

/**
 * @throws {RouteRegistrationError} — at boot, deliberately.
 */
export function assertRouteMetadata(
  method: string,
  url: string,
  metadata: RouteMetadata | undefined,
): void {
  if (isCorsPreflightRoute(method, url)) return;

  if (metadata === undefined) {
    throw new RouteRegistrationError(
      method,
      url,
      'no permission and no explicit public marker. Declare config.findneo with either ' +
        "{ permission: 'jobs.read' } or { public: true, publicReason: '…' } (SEC-021). " +
        'Absence is never treated as public.',
    );
  }

  if (isPublic(metadata)) {
    if (metadata.publicReason.trim() === '') {
      throw new RouteRegistrationError(
        method,
        url,
        'marked public with an empty publicReason. A public route needs a stated reason ' +
          'so review can weigh it (SEC-021).',
      );
    }
    return;
  }

  if (metadata.permission.trim() === '') {
    throw new RouteRegistrationError(method, url, 'declares an empty permission key');
  }
}

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly metadata: RouteMetadata;
}

/**
 * The count CI compares against a committed number, so a new public route
 * cannot appear unnoticed (SEC-021).
 *
 * Counts distinct **URLs**, not route entries. Fastify generates a `HEAD` for
 * every `GET`, inheriting its config — so a single public endpoint registers
 * twice and a naive count reports double. The committed number must track
 * surfaces a caller can reach, not table rows.
 */
export function countPublicRoutes(routes: readonly RegisteredRoute[]): number {
  return new Set(publicRoutes(routes).map((route) => route.url)).size;
}

export function publicRoutes(routes: readonly RegisteredRoute[]): readonly RegisteredRoute[] {
  return routes.filter((route) => isPublic(route.metadata));
}
