import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import {
  ActiveFormResponse,
  CreateTemplateBody,
  CreatedIdResponse,
  ReplaceFieldsBody,
} from './jobs.schemas.js';
import { JOBS_SECURITY, type JobsRouteOptions } from './jobs.routes.js';

/** Form template routes (T-041, 08-lld-jobs §2). */

const VersionParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  versionId: Type.String({ format: 'uuid' }),
});

function registerList(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/form-templates',
    {
      config: { findneo: { permission: 'forms.read' } },
      schema: { tags: ['forms'], security: JOBS_SECURITY, response: { 200: Type.Any() } },
    },
    async (request, reply) => {
      await reply.send({ data: await controller.listTemplates(actor(request)) });
    },
  );
}

/**
 * The contract the frontend renders from. Adding a field to a company's form
 * requires no frontend release — the shape arrives from here.
 */
function registerActive(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/form-templates/:entityType/active',
    {
      config: { findneo: { permission: 'forms.read' } },
      schema: {
        tags: ['forms'],
        security: JOBS_SECURITY,
        params: Type.Object({
          entityType: Type.Unsafe<'job' | 'application'>({
            type: 'string',
            enum: ['job', 'application'],
          }),
        }),
        response: { 200: ActiveFormResponse },
      },
    },
    async (request, reply) => {
      const { entityType } = request.params as { entityType: string };
      await reply.send(await controller.activeForm(actor(request), entityType));
    },
  );
}

function registerCreateTemplate(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/form-templates',
    {
      config: { findneo: { permission: 'forms.configure' } },
      schema: {
        tags: ['forms'],
        security: JOBS_SECURITY,
        body: CreateTemplateBody,
        response: { 201: CreatedIdResponse },
      },
    },
    async (request, reply) => {
      const created = await controller.createTemplate(
        actor(request),
        request.body as CreateTemplateBody,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerCreateVersion(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/form-templates/:id/versions',
    {
      config: { findneo: { permission: 'forms.configure' } },
      schema: {
        tags: ['forms'],
        security: JOBS_SECURITY,
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 201: CreatedIdResponse },
      },
    },
    async (request, reply) => {
      const created = await controller.createVersion(
        actor(request),
        (request.params as { id: string }).id,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerEditVersion(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.patch(
    '/v1/form-templates/:id/versions/:versionId',
    {
      config: { findneo: { permission: 'forms.configure' } },
      schema: {
        tags: ['forms'],
        summary: 'Replace a draft version’s fields',
        security: JOBS_SECURITY,
        params: VersionParams,
        body: ReplaceFieldsBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      /* Draft only. Editing a published version is 409 — an existing job
         pinned to it would silently start validating against new rules. */
      await controller.replaceFields(
        actor(request),
        (request.params as { versionId: string }).versionId,
        request.body as ReplaceFieldsBody,
      );
      await reply.status(204).send();
    },
  );
}

function registerPublishVersion(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/form-templates/:id/versions/:versionId/actions/publish',
    {
      config: { findneo: { permission: 'forms.configure' } },
      schema: {
        tags: ['forms'],
        security: JOBS_SECURITY,
        params: VersionParams,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      await controller.publishVersion(
        actor(request),
        (request.params as { versionId: string }).versionId,
      );
      await reply.status(204).send();
    },
  );
}

export function registerFormRoutes(app: FastifyInstance, options: JobsRouteOptions): void {
  registerList(app, options);
  registerActive(app, options);
  registerCreateTemplate(app, options);
  registerCreateVersion(app, options);
  registerEditVersion(app, options);
  registerPublishVersion(app, options);
}
