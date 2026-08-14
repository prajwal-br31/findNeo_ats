import type { FastifyInstance } from 'fastify';

import type { PermissionsService } from '../modules/identity/application/permissions.service.js';
import { requirePermission } from '../shared/authz/authorize.js';
import type { ResolvedPermissions } from '../shared/authz/permission-cache.js';
import type { FieldVisibilityService } from '../modules/identity/application/field-visibility.service.js';
import type { FieldVisibility } from '../shared/authz/masking.js';
import type { RouteConfig } from '../shared/http/route-metadata.js';

/**
 * The authorization hook (T-028, 04 §1).
 *
 * Runs after `registerAuthentication`, which established *who* the caller is.
 * This decides whether they may proceed, from the permission the route
 * declared in its SEC-021 metadata.
 *
 * **Fail-closed twice over.** A route without metadata never registers —
 * `assertRouteMetadata` throws at boot — and a route that reaches this hook
 * with neither `public: true` nor a permission is refused rather than allowed.
 * The second check is unreachable given the first, and it stays because
 * "unreachable" is a property of today's registration code.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved for every permissioned route. Absent on public ones. */
    permissions?: ResolvedPermissions;
    /**
     * The tenant's field-visibility rules, resolved once per request.
     *
     * Here rather than per row: a list endpoint serialising 100 jobs would
     * otherwise resolve the rules 100 times, and masking is applied to every
     * one of them (BR-091).
     */
    fieldVisibility?: FieldVisibility;
  }
}

export function registerAuthorization(
  app: FastifyInstance,
  permissions: PermissionsService,
  fieldVisibility: FieldVisibilityService,
): void {
  app.addHook('preHandler', async (request) => {
    const metadata = (request.routeOptions.config as RouteConfig | undefined)?.findneo;
    if (metadata?.public === true) return;

    /* `request.auth` is set by the authentication hook, which is registered
       first and throws 401 when it cannot establish a caller. Reaching here
       without it means the hook order changed. */
    const auth = request.auth;
    if (auth === undefined) return;

    const resolved = await permissions.resolve(auth.companyId, auth.userId);
    request.permissions = resolved;
    request.fieldVisibility = await fieldVisibility.resolve(auth.companyId);

    const required = metadata?.permission;
    if (required === undefined) {
      /* Neither public nor permissioned. Registration prevents this; if it
         ever happens anyway, refuse. */
      throw new Error(
        `route ${request.method} ${request.routeOptions.url ?? request.url} reached the ` +
          'authorization hook with no permission and no public marker',
      );
    }

    requirePermission(resolved, required);
  });
}
