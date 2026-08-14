import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { JOB_ID_PARAM, JOBS_SECURITY, type JobsRouteOptions } from './jobs.routes.js';
import {
  AddTeamMemberBody,
  CreateStageBody,
  CreatedIdResponse,
  ReorderStagesBody,
  SkillListResponse,
  StageListResponse,
  TeamListResponse,
  UpdateStageBody,
} from './jobs.schemas.js';

/** Pipeline, hiring team and skill routes (T-046, T-047, T-048). */

const StageParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  stageId: Type.String({ format: 'uuid' }),
});

function registerStageList(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/jobs/:id/stages',
    {
      config: { findneo: { permission: 'pipeline.read' } },
      schema: {
        tags: ['pipeline'],
        security: JOBS_SECURITY,
        params: JOB_ID_PARAM,
        response: { 200: StageListResponse },
      },
    },
    async (request, reply) => {
      const data = await controller.listStages(
        actor(request),
        (request.params as { id: string }).id,
      );
      await reply.send({ data });
    },
  );
}

function registerStageCreate(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/jobs/:id/stages',
    {
      config: { findneo: { permission: 'pipeline.configure' } },
      schema: {
        tags: ['pipeline'],
        security: JOBS_SECURITY,
        params: JOB_ID_PARAM,
        body: CreateStageBody,
        response: { 201: CreatedIdResponse },
      },
    },
    async (request, reply) => {
      const created = await controller.addStage(
        actor(request),
        (request.params as { id: string }).id,
        request.body as CreateStageBody,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerStageEdits(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.patch(
    '/v1/jobs/:id/stages/:stageId',
    {
      config: { findneo: { permission: 'pipeline.configure' } },
      schema: {
        tags: ['pipeline'],
        security: JOBS_SECURITY,
        params: StageParams,
        body: UpdateStageBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const params = request.params as { id: string; stageId: string };
      const body = request.body as UpdateStageBody;
      await controller.renameStage(actor(request), params.id, params.stageId, body.name);
      await reply.status(204).send();
    },
  );

  app.delete(
    '/v1/jobs/:id/stages/:stageId',
    {
      config: { findneo: { permission: 'pipeline.configure' } },
      schema: {
        tags: ['pipeline'],
        security: JOBS_SECURITY,
        params: StageParams,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const params = request.params as { id: string; stageId: string };
      await controller.deleteStage(actor(request), params.id, params.stageId);
      await reply.status(204).send();
    },
  );
}

/**
 * Reorder is a **collection** action — the one documented exception to "no
 * actions on collections" (07 §2). Reordering is inherently atomic across the
 * set, and N individual PATCHes cannot be made safe against the per-job unique
 * index on `sequence_order`.
 */
function registerReorder(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/jobs/:id/stages/actions/reorder',
    {
      config: { findneo: { permission: 'pipeline.configure' } },
      schema: {
        tags: ['pipeline'],
        security: JOBS_SECURITY,
        params: JOB_ID_PARAM,
        body: ReorderStagesBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const body = request.body as ReorderStagesBody;
      await controller.reorderStages(
        actor(request),
        (request.params as { id: string }).id,
        body.stageIds,
      );
      await reply.status(204).send();
    },
  );
}

function registerTeam(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/jobs/:id/hiring-team',
    {
      config: { findneo: { permission: 'jobs.team.read' } },
      schema: {
        tags: ['pipeline'],
        security: JOBS_SECURITY,
        params: JOB_ID_PARAM,
        response: { 200: TeamListResponse },
      },
    },
    async (request, reply) => {
      const data = await controller.listTeam(actor(request), (request.params as { id: string }).id);
      await reply.send({ data });
    },
  );
}

function registerAddTeamMember(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/jobs/:id/hiring-team',
    {
      config: { findneo: { permission: 'jobs.team.manage' } },
      schema: {
        tags: ['pipeline'],
        security: JOBS_SECURITY,
        params: JOB_ID_PARAM,
        body: AddTeamMemberBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      await controller.addTeamMember(
        actor(request),
        (request.params as { id: string }).id,
        request.body as AddTeamMemberBody,
      );
      await reply.status(204).send();
    },
  );
}

function registerRemoveTeamMember(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.delete(
    '/v1/jobs/:id/hiring-team/:userId',
    {
      config: { findneo: { permission: 'jobs.team.manage' } },
      schema: {
        tags: ['pipeline'],
        security: JOBS_SECURITY,
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          userId: Type.String({ format: 'uuid' }),
        }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const params = request.params as { id: string; userId: string };
      await controller.removeTeamMember(actor(request), params.id, params.userId);
      await reply.status(204).send();
    },
  );
}

function registerSkills(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/skills',
    {
      config: { findneo: { permission: 'jobs.read' } },
      schema: { tags: ['pipeline'], security: JOBS_SECURITY, response: { 200: SkillListResponse } },
    },
    async (request, reply) => {
      await reply.send({ data: await controller.listSkills(actor(request)) });
    },
  );
}

function registerJobSkills(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/jobs/:id/skills',
    {
      config: { findneo: { permission: 'jobs.read' } },
      schema: {
        tags: ['pipeline'],
        security: JOBS_SECURITY,
        params: JOB_ID_PARAM,
        response: { 200: SkillListResponse },
      },
    },
    async (request, reply) => {
      const data = await controller.listJobSkills(
        actor(request),
        (request.params as { id: string }).id,
      );
      await reply.send({ data });
    },
  );
}

function registerRemoveJobSkill(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.delete(
    '/v1/jobs/:id/skills/:skillId',
    {
      config: { findneo: { permission: 'jobs.update' } },
      schema: {
        tags: ['pipeline'],
        security: JOBS_SECURITY,
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          skillId: Type.String({ format: 'uuid' }),
        }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const params = request.params as { id: string; skillId: string };
      await controller.removeJobSkill(actor(request), params.id, params.skillId);
      await reply.status(204).send();
    },
  );
}

function registerPipelineTemplates(app: FastifyInstance, options: JobsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/pipeline-templates',
    {
      config: { findneo: { permission: 'pipeline.read' } },
      schema: { tags: ['pipeline'], security: JOBS_SECURITY, response: { 200: SkillListResponse } },
    },
    async (request, reply) => {
      await reply.send({ data: await controller.listPipelineTemplates(actor(request)) });
    },
  );
}

export function registerPipelineRoutes(app: FastifyInstance, options: JobsRouteOptions): void {
  registerStageList(app, options);
  registerStageCreate(app, options);
  registerStageEdits(app, options);
  registerReorder(app, options);
  registerTeam(app, options);
  registerAddTeamMember(app, options);
  registerRemoveTeamMember(app, options);
  registerSkills(app, options);
  registerJobSkills(app, options);
  registerRemoveJobSkill(app, options);
  registerPipelineTemplates(app, options);
}
