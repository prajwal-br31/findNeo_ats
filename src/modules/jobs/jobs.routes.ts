import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { JobsController, RequestActor } from './jobs.controller.js';
import {
  CreateJobBody,
  CreatedIdResponse,
  JobListResponse,
  JobResponse,
  SetConfidentialBody,
  UpdateJobBody,
} from './jobs.schemas.js';
import { registerFormRoutes } from './forms.routes.js';
import { registerPipelineRoutes } from './pipeline.routes.js';

/** Job routes (08-lld-jobs §2). Every one permissioned; none public. */

export interface JobsRouteOptions {
  readonly controller: JobsController;
  /** Resolved once per request by the authorization pipeline. */
  readonly actor: (request: unknown) => RequestActor;
}

export const JOB_ID_PARAM = Type.Object({ id: Type.String({ format: 'uuid' }) });
export const JOBS_SECURITY = [{ bearerAuth: [] }];

function registerList(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/jobs',
    {
      config: { findneo: { permission: 'jobs.read' } },
      schema: { tags: ['jobs'], security: JOBS_SECURITY, response: { 200: JobListResponse } },
    },
    async (request, reply) => {
      await reply.send({ data: await controller.listJobs(actor(request)) });
    },
  );
}

function registerGet(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/jobs/:id',
    {
      config: { findneo: { permission: 'jobs.read' } },
      schema: {
        tags: ['jobs'],
        security: JOBS_SECURITY,
        params: JOB_ID_PARAM,
        response: { 200: JobResponse },
      },
    },
    async (request, reply) => {
      const job = await controller.getJob(actor(request), (request.params as { id: string }).id);
      await reply.send(job);
    },
  );
}

function registerCreate(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/jobs',
    {
      config: { findneo: { permission: 'jobs.create' } },
      schema: {
        tags: ['jobs'],
        security: JOBS_SECURITY,
        body: CreateJobBody,
        response: { 201: CreatedIdResponse },
      },
    },
    async (request, reply) => {
      const created = await controller.createJob(actor(request), request.body as CreateJobBody);
      await reply.status(201).send(created);
    },
  );
}

function registerUpdate(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.patch(
    '/v1/jobs/:id',
    {
      config: { findneo: { permission: 'jobs.update' } },
      schema: {
        tags: ['jobs'],
        security: JOBS_SECURITY,
        params: JOB_ID_PARAM,
        body: UpdateJobBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      await controller.updateJob(
        actor(request),
        (request.params as { id: string }).id,
        request.body as UpdateJobBody,
      );
      await reply.status(204).send();
    },
  );
}

function registerDelete(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.delete(
    '/v1/jobs/:id',
    {
      config: { findneo: { permission: 'jobs.delete' } },
      schema: {
        tags: ['jobs'],
        security: JOBS_SECURITY,
        params: JOB_ID_PARAM,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      await controller.deleteJob(actor(request), (request.params as { id: string }).id);
      await reply.status(204).send();
    },
  );
}

function registerLifecycle(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  const action = (
    path: string,
    permission: string,
    run: (a: RequestActor, id: string) => Promise<void>,
  ): void => {
    app.post(
      path,
      {
        config: { findneo: { permission } },
        schema: {
          tags: ['jobs'],
          security: JOBS_SECURITY,
          params: JOB_ID_PARAM,
          response: { 204: Type.Null() },
        },
      },
      async (request, reply) => {
        await run(actor(request), (request.params as { id: string }).id);
        await reply.status(204).send();
      },
    );
  };

  /* Publish is idempotent — an already-open job is a no-op, so a retry after a
     dropped response succeeds rather than 409ing. */
  action('/v1/jobs/:id/actions/publish', 'jobs.publish', (a, id) => controller.publishJob(a, id));
  action('/v1/jobs/:id/actions/close', 'jobs.close', (a, id) => controller.closeJob(a, id));
  action('/v1/jobs/:id/actions/reopen', 'jobs.publish', (a, id) => controller.reopenJob(a, id));
  action('/v1/jobs/:id/actions/hold', 'jobs.update', (a, id) => controller.holdJob(a, id));
}

function registerSetConfidential(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/jobs/:id/actions/set-confidential',
    {
      config: { findneo: { permission: 'jobs.update' } },
      schema: {
        tags: ['jobs'],
        security: JOBS_SECURITY,
        params: JOB_ID_PARAM,
        body: SetConfidentialBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const body = request.body as SetConfidentialBody;
      /* Setting it withdraws the job publicly; clearing it does not
         republish (BR-033). */
      await controller.setConfidential(
        actor(request),
        (request.params as { id: string }).id,
        body.confidential,
      );
      await reply.status(204).send();
    },
  );
}

export function registerJobRoutes(app: FastifyInstance, options: JobsRouteOptions): void {
  registerList(app, options);
  registerGet(app, options);
  registerCreate(app, options);
  registerUpdate(app, options);
  registerDelete(app, options);
  registerLifecycle(app, options);
  registerSetConfidential(app, options);
  registerFormRoutes(app, options);
  registerPipelineRoutes(app, options);
}
