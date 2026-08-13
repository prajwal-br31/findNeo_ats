import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { TokenVerifierPort } from '../shared/ports/token-issuer.js';
import { unauthenticated } from '../shared/errors/app-error.js';
import type { RouteConfig } from '../shared/http/route-metadata.js';
import { unsafeCompanyId, unsafeUserId, type CompanyId, type UserId } from '../shared/types/ids.js';

/**
 * Bearer-token **authentication**. Not authorization.
 *
 * This establishes *who* is calling. Deciding what they may do — permission
 * resolution, the tenant-keyed cache, route permission checks, masking — is
 * T-027 through T-029 and is deliberately not here. Conflating the two is how
 * an "authenticated" check ends up standing in for an authorization one.
 *
 * The hook keys off the SEC-021 metadata that already exists on every route:
 * `public: true` routes are skipped, everything else must present a valid
 * token. That means a new route is authenticated by default — the same
 * fail-closed direction as route registration itself, and for the same reason.
 */

export interface AuthContext {
  readonly userId: UserId;
  readonly companyId: CompanyId;
  readonly sessionId: string;
  readonly capability: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present on every non-public route; absent on public ones. */
    auth?: AuthContext;
  }
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const [scheme, value] = header.split(' ');
  /* Case-insensitive scheme per RFC 7235, and a missing value is not a token. */
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value === '') return undefined;
  return value;
}

export function registerAuthentication(app: FastifyInstance, verifier: TokenVerifierPort): void {
  app.addHook('preHandler', async (request) => {
    const metadata = (request.routeOptions.config as RouteConfig | undefined)?.findneo;

    /* Absence is not treated as public. A route with no metadata never
       registers — `assertRouteMetadata` throws at boot — so reaching here
       without metadata means something bypassed registration, and the safe
       reading of that is "not public". */
    if (metadata?.public === true) return;

    const token = bearerToken(request);
    if (token === undefined) throw unauthenticated('Authentication is required.');

    const claims = await verifier.verifyAccessToken(token);
    if (claims === undefined) throw unauthenticated('Authentication is required.');

    /* Platform staff carry `cid: null` and have no tenant to bind. They are
       served by the platform surface, not by `/v1/*` tenant routes, so a null
       here on a tenant route is a token being used where it does not belong. */
    if (claims.cid === null) throw unauthenticated('Authentication is required.');

    request.auth = {
      userId: unsafeUserId(claims.sub),
      companyId: unsafeCompanyId(claims.cid),
      sessionId: claims.sid,
      capability: claims.cap,
    };
  });
}

/**
 * Reads the context a handler needs, or throws.
 *
 * Handlers call this rather than reading `request.auth` directly, so the
 * non-null assertion lives in one place that has a reason attached instead of
 * being repeated with a `!` at every call site.
 */
export function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated('Authentication is required.');
  return auth;
}
