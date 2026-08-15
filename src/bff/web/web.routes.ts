import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { ResolvedPermissions } from '../../shared/authz/permission-cache.js';
import { unsafeCompanyId, unsafeUserId } from '../../shared/types/ids.js';

import type { BootstrapAssembler } from './bootstrap.assembler.js';

/**
 * T-013b — the `/bff/web/*` namespace.
 *
 * Served by the same process and the same public listener as `/v1/*`
 * (AGENTS.md §4), and subject to the same authentication and authorization
 * hooks — a BFF route is not a side door. What it is not subject to is the
 * `/v1` contract: this namespace may change shape whenever the web client
 * does, which is the entire reason it exists separately.
 */

export interface WebBffRouteOptions {
  readonly assembler: BootstrapAssembler;
  readonly currentUser: (request: unknown) => {
    companyId: string;
    userId: string;
    capability: number;
    permissions: ResolvedPermissions;
  };
}

const BootstrapResponse = Type.Object(
  {
    user: Type.Object(
      {
        id: Type.String({ format: 'uuid' }),
        email: Type.String(),
        fullName: Type.String(),
        companyId: Type.String({ format: 'uuid' }),
        companyName: Type.String(),
        status: Type.String(),
        mfaEnabled: Type.Boolean(),
        roles: Type.Array(Type.String()),
        permissions: Type.Array(Type.String()),
        departments: Type.Array(
          Type.Object(
            {
              id: Type.String({ format: 'uuid' }),
              name: Type.String(),
              isPrimary: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        ),
        capability: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    /* Null and empty mean different things here — see the assembler. */
    departments: Type.Union([
      Type.Array(
        Type.Object(
          {
            id: Type.String({ format: 'uuid' }),
            name: Type.String(),
            memberCount: Type.Integer(),
          },
          { additionalProperties: false },
        ),
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export function registerWebBffRoutes(app: FastifyInstance, options: WebBffRouteOptions): void {
  const { assembler, currentUser } = options;

  app.get(
    '/bff/web/bootstrap',
    {
      /* Same reasoning as `/v1/users/current`: booting the app is not a
         capability a role grants, and gating it would let an over-restricted
         role lock a user out of the shell entirely. The parts *inside* the
         response are still gated individually. */
      config: { findneo: { permission: 'self' } },
      schema: {
        tags: ['bff'],
        summary: 'Everything the web client needs on a cold start, in one call',
        security: [{ bearerAuth: [] }],
        response: { 200: BootstrapResponse },
      },
    },
    async (request, reply) => {
      const { companyId, userId, capability, permissions } = currentUser(request);
      const payload = await assembler.assemble(
        unsafeCompanyId(companyId),
        unsafeUserId(userId),
        capability,
        permissions,
      );
      await reply.send(payload);
    },
  );
}
