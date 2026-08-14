import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { ID_PARAM, SECURITY, type AccessRouteOptions } from './access.routes.js';
import { CompanyListResponse, ImpersonateBody, ImpersonateResponse } from './access.schemas.js';

/**
 * The platform-admin surface (T-033, 08 §2).
 *
 * Every route here requires a `platform.*` permission, which only the
 * `system_admin` platform-default role carries — and that role holds nothing
 * else at all (04 §3). Tenant data is reached only through an impersonation
 * grant, never ambiently.
 */

function registerCompanies(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller } = options;

  app.get(
    '/v1/platform/companies',
    {
      config: { findneo: { permission: 'platform.companies.read' } },
      schema: { tags: ['platform'], security: SECURITY, response: { 200: CompanyListResponse } },
    },
    async (_request, reply) => {
      await reply.send({ data: await controller.listCompanies() });
    },
  );
}

function registerImpersonate(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser, traceId } = options;

  app.post(
    '/v1/platform/companies/:id/actions/impersonate',
    {
      config: { findneo: { permission: 'platform.support.impersonate' } },
      schema: {
        tags: ['platform'],
        security: SECURITY,
        params: ID_PARAM,
        body: ImpersonateBody,
        response: { 201: ImpersonateResponse },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const result = await controller.startImpersonation(
        userId,
        (request.params as { id: string }).id,
        request.body as ImpersonateBody,
        traceId(request),
      );
      await reply.status(201).send(result);
    },
  );
}

function registerEndImpersonation(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser, traceId } = options;

  app.post(
    '/v1/platform/impersonation/:id/actions/end',
    {
      config: { findneo: { permission: 'platform.support.impersonate' } },
      schema: {
        tags: ['platform'],
        security: SECURITY,
        params: ID_PARAM,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      await controller.endImpersonation(
        userId,
        (request.params as { id: string }).id,
        traceId(request),
      );
      await reply.status(204).send();
    },
  );
}

export function registerPlatformRoutes(app: FastifyInstance, options: AccessRouteOptions): void {
  registerCompanies(app, options);
  registerImpersonate(app, options);
  registerEndImpersonation(app, options);
}
