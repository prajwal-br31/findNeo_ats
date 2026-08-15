import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { BootstrapAssembler } from '../bff/web/bootstrap.assembler.js';
import { registerWebBffRoutes } from '../bff/web/web.routes.js';
import type { ResolvedPermissions } from '../shared/authz/permission-cache.js';

import { requireAuth } from './authentication.js';

/**
 * Wires `/bff/web/*` onto the public listener (T-013b, AGENTS.md §4).
 *
 * Its own file rather than another block in `api.ts`, because the BFF is a
 * separate namespace with a separate contract — and because `api.ts` is at the
 * file-length limit, which is the signal to split rather than keep appending.
 */

/**
 * The authorization hook runs before every handler on this instance and puts
 * the resolved set on the request. If it is missing, the hook order changed —
 * and the BFF must not respond as though the caller holds nothing *or*
 * everything. Refusing is the only safe reading.
 */
function requirePermissions(request: FastifyRequest): ResolvedPermissions {
  const resolved = request.permissions;
  if (resolved === undefined) {
    throw new Error(
      'the authorization hook did not run before a BFF handler — permissions are unresolved',
    );
  }
  return resolved;
}

export function registerWebBff(app: FastifyInstance, assembler: BootstrapAssembler): void {
  registerWebBffRoutes(app, {
    assembler,
    currentUser: (request) => {
      const req = request as FastifyRequest;
      const auth = requireAuth(req);
      return {
        companyId: auth.companyId,
        userId: auth.userId,
        capability: auth.capability,
        permissions: requirePermissions(req),
      };
    },
  });
}
