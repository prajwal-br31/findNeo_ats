import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { ID_PARAM, SECURITY, type AccessRouteOptions } from './access.routes.js';
import {
  AssignRoleBody,
  AssignmentListResponse,
  CreateRoleBody,
  CreatedIdResponse,
  PermissionListResponse,
  RoleListResponse,
  UpdateRoleBody,
} from './access.schemas.js';

/** Role and assignment routes (T-032, 08 §2). */

function registerPermissionCatalog(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.get(
    '/v1/permissions',
    {
      config: { findneo: { permission: 'roles.read' } },
      schema: { tags: ['roles'], security: SECURITY, response: { 200: PermissionListResponse } },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      await reply.send({ data: await controller.listPermissions(companyId) });
    },
  );
}

function registerList(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.get(
    '/v1/roles',
    {
      config: { findneo: { permission: 'roles.read' } },
      schema: { tags: ['roles'], security: SECURITY, response: { 200: RoleListResponse } },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      await reply.send({ data: await controller.listRoles(companyId) });
    },
  );
}

function registerCreate(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.post(
    '/v1/roles',
    {
      config: { findneo: { permission: 'roles.create' } },
      schema: {
        tags: ['roles'],
        security: SECURITY,
        body: CreateRoleBody,
        response: { 201: CreatedIdResponse },
      },
    },
    async (request, reply) => {
      const { companyId, userId } = currentUser(request);
      const created = await controller.createRole(
        companyId,
        userId,
        request.body as CreateRoleBody,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerUpdate(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.patch(
    '/v1/roles/:id',
    {
      config: { findneo: { permission: 'roles.update' } },
      schema: {
        tags: ['roles'],
        security: SECURITY,
        params: ID_PARAM,
        body: UpdateRoleBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { companyId, userId } = currentUser(request);
      await controller.updateRole(
        companyId,
        userId,
        (request.params as { id: string }).id,
        request.body as UpdateRoleBody,
      );
      await reply.status(204).send();
    },
  );
}

function registerDelete(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.delete(
    '/v1/roles/:id',
    {
      config: { findneo: { permission: 'roles.delete' } },
      schema: {
        tags: ['roles'],
        security: SECURITY,
        params: ID_PARAM,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      await controller.deleteRole(companyId, (request.params as { id: string }).id);
      await reply.status(204).send();
    },
  );
}

function registerListAssignments(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.get(
    '/v1/users/:id/roles',
    {
      config: { findneo: { permission: 'roles.read' } },
      schema: {
        tags: ['roles'],
        security: SECURITY,
        params: ID_PARAM,
        response: { 200: AssignmentListResponse },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      const data = await controller.listAssignments(
        companyId,
        (request.params as { id: string }).id,
      );
      await reply.send({ data });
    },
  );
}

function registerAssign(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.post(
    '/v1/users/:id/roles',
    {
      config: { findneo: { permission: 'roles.assign' } },
      schema: {
        tags: ['roles'],
        security: SECURITY,
        params: ID_PARAM,
        body: AssignRoleBody,
        response: { 201: CreatedIdResponse },
      },
    },
    async (request, reply) => {
      const { companyId, userId } = currentUser(request);
      const created = await controller.assignRole(
        companyId,
        userId,
        (request.params as { id: string }).id,
        request.body as AssignRoleBody,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerRevoke(app: FastifyInstance, options: AccessRouteOptions): void {
  const { controller, currentUser } = options;

  app.delete(
    '/v1/users/:id/roles/:assignmentId',
    {
      config: { findneo: { permission: 'roles.assign' } },
      schema: {
        tags: ['roles'],
        security: SECURITY,
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          assignmentId: Type.String({ format: 'uuid' }),
        }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      const params = request.params as { id: string; assignmentId: string };
      await controller.revokeAssignment(companyId, params.id, params.assignmentId);
      await reply.status(204).send();
    },
  );
}

export function registerRoleRoutes(app: FastifyInstance, options: AccessRouteOptions): void {
  registerPermissionCatalog(app, options);
  registerList(app, options);
  registerCreate(app, options);
  registerUpdate(app, options);
  registerDelete(app, options);
  registerListAssignments(app, options);
  registerAssign(app, options);
  registerRevoke(app, options);
}
