import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { AccessController } from './access.controller.js';
import {
  AddMemberBody,
  CreateDepartmentBody,
  CreatedIdResponse,
  DepartmentListResponse,
  UpdateDepartmentBody,
} from './access.schemas.js';
import { registerPlatformRoutes } from './platform.routes.js';
import { registerRoleRoutes } from './roles.routes.js';

/**
 * Department and membership routes (08 §2), plus the entry point that pulls in
 * the role and platform route files.
 *
 * Every route carries a permission from the matrix in 04 §3. None is public:
 * these act on tenant configuration, and there is no unauthenticated path in.
 */

export interface AccessRouteOptions {
  readonly controller: AccessController;
  readonly currentUser: (request: unknown) => { companyId: string; userId: string };
  readonly traceId: (request: unknown) => string;
}

export const ID_PARAM = Type.Object({ id: Type.String({ format: 'uuid' }) });
export const SECURITY = [{ bearerAuth: [] }];

function registerList(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.get(
    '/v1/departments',
    {
      config: { findneo: { permission: 'departments.read' } },
      schema: {
        tags: ['departments'],
        security: SECURITY,
        response: { 200: DepartmentListResponse },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      await reply.send({ data: await controller.listDepartments(companyId) });
    },
  );
}

function registerCreate(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.post(
    '/v1/departments',
    {
      config: { findneo: { permission: 'departments.create' } },
      schema: {
        tags: ['departments'],
        security: SECURITY,
        body: CreateDepartmentBody,
        response: { 201: CreatedIdResponse },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      const created = await controller.createDepartment(
        companyId,
        request.body as CreateDepartmentBody,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerRename(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.patch(
    '/v1/departments/:id',
    {
      config: { findneo: { permission: 'departments.update' } },
      schema: {
        tags: ['departments'],
        security: SECURITY,
        params: ID_PARAM,
        body: UpdateDepartmentBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      const body = request.body as UpdateDepartmentBody;
      await controller.renameDepartment(
        companyId,
        (request.params as { id: string }).id,
        body.name,
      );
      await reply.status(204).send();
    },
  );
}

function registerDelete(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.delete(
    '/v1/departments/:id',
    {
      config: { findneo: { permission: 'departments.delete' } },
      schema: {
        tags: ['departments'],
        security: SECURITY,
        params: ID_PARAM,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      await controller.deleteDepartment(companyId, (request.params as { id: string }).id);
      await reply.status(204).send();
    },
  );
}

function registerAddMember(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.post(
    '/v1/departments/:id/members',
    {
      config: { findneo: { permission: 'departments.members.manage' } },
      schema: {
        tags: ['departments'],
        security: SECURITY,
        params: ID_PARAM,
        body: AddMemberBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      const body = request.body as AddMemberBody;
      await controller.addMember(companyId, (request.params as { id: string }).id, body.userId);
      await reply.status(204).send();
    },
  );
}

function registerRemoveMember(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.delete(
    '/v1/departments/:id/members/:userId',
    {
      config: { findneo: { permission: 'departments.members.manage' } },
      schema: {
        tags: ['departments'],
        security: SECURITY,
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          userId: Type.String({ format: 'uuid' }),
        }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      const params = request.params as { id: string; userId: string };
      await controller.removeMember(companyId, params.id, params.userId);
      await reply.status(204).send();
    },
  );
}

export function registerAccessRoutes(app: FastifyInstance, options: AccessRouteOptions): void {
  registerList(app, options);
  registerCreate(app, options);
  registerRename(app, options);
  registerDelete(app, options);
  registerAddMember(app, options);
  registerRemoveMember(app, options);
  registerRoleRoutes(app, options);
  registerPlatformRoutes(app, options);
}
