import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { CandidatesController, RequestActor } from './candidates.controller.js';
import { AddToPoolBody, CreatedIdResponse, PoolStatusBody } from './candidates.schemas.js';

/**
 * `/v1/talent-pool/*` (T-063, D-010).
 *
 * Tenant-scoped by RLS on `owner_company_id`. There is no cross-tenant logic
 * in these handlers because there is none to write: an org querying this sees
 * its own pool and an agency sees its own, for the same reason and by the same
 * mechanism as every other table.
 */

export interface PoolRouteOptions {
  readonly controller: CandidatesController;
  readonly actor: (request: unknown) => RequestActor;
}

const SECURITY = [{ bearerAuth: [] }];
const ID_PARAM = Type.Object({ id: Type.String({ format: 'uuid' }) });

function registerPoolReads(app: FastifyInstance, options: PoolRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/talent-pool',
    {
      config: { findneo: { permission: 'talent_pool.read' } },
      schema: {
        tags: ['talent-pool'],
        security: SECURITY,
        querystring: Type.Object(
          {
            status: Type.Optional(
              Type.Unsafe<string>({
                type: 'string',
                enum: ['active', 'archived', 'placed'],
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ data: Type.Array(Type.Any()) }) },
      },
    },
    async (request, reply) => {
      const { status } = request.query as { status?: string };
      await reply.send({ data: await controller.listPool(actor(request), status) });
    },
  );
}

function registerPoolWrites(app: FastifyInstance, options: PoolRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/talent-pool',
    {
      config: { findneo: { permission: 'talent_pool.manage' } },
      schema: {
        tags: ['talent-pool'],
        summary: 'Add a candidate to the pool; re-adding revives an archived entry',
        security: SECURITY,
        body: AddToPoolBody,
        response: { 201: CreatedIdResponse },
      },
    },
    async (request, reply) => {
      const created = await controller.addToPool(actor(request), request.body as AddToPoolBody);
      await reply.status(201).send(created);
    },
  );
}

function registerPoolStatus(app: FastifyInstance, options: PoolRouteOptions): void {
  const { controller, actor } = options;

  app.patch(
    '/v1/talent-pool/:id',
    {
      config: { findneo: { permission: 'talent_pool.manage' } },
      schema: {
        tags: ['talent-pool'],
        security: SECURITY,
        params: ID_PARAM,
        body: PoolStatusBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { status } = request.body as PoolStatusBody;
      await controller.setPoolStatus(actor(request), id, status);
      await reply.status(204).send();
    },
  );

  app.delete(
    '/v1/talent-pool/:id',
    {
      config: { findneo: { permission: 'talent_pool.manage' } },
      schema: {
        tags: ['talent-pool'],
        summary: 'Remove the membership. The candidate row survives',
        security: SECURITY,
        params: ID_PARAM,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await controller.removeFromPool(actor(request), id);
      await reply.status(204).send();
    },
  );
}

export function registerPoolRoutes(app: FastifyInstance, options: PoolRouteOptions): void {
  registerPoolReads(app, options);
  registerPoolWrites(app, options);
  registerPoolStatus(app, options);
}
