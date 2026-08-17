import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { BusinessRuleError } from '../../shared/errors/app-error.js';

import type { CandidatesController, RequestActor } from './candidates.controller.js';
import {
  ApplicationResponse,
  CreatedIdResponse,
  DecisionBody,
  SubmitApplicationBody,
  TransferApplicationBody,
} from './candidates.schemas.js';

/** `/v1/applications/*` — submission, lifecycle and decisions (T-065 to T-069). */

export interface ApplicationsRouteOptions {
  readonly controller: CandidatesController;
  readonly actor: (request: unknown) => RequestActor;
}

const SECURITY = [{ bearerAuth: [] }];
const ID_PARAM = Type.Object({ id: Type.String({ format: 'uuid' }) });
const LIST_RESPONSE = Type.Object({ data: Type.Array(ApplicationResponse) });

function registerReads(app: FastifyInstance, options: ApplicationsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/applications',
    {
      config: { findneo: { permission: 'applications.read' } },
      schema: {
        tags: ['applications'],
        summary: 'Applications for a job, or for a candidate',
        security: SECURITY,
        querystring: Type.Object(
          {
            jobId: Type.Optional(Type.String({ format: 'uuid' })),
            candidateId: Type.Optional(Type.String({ format: 'uuid' })),
          },
          { additionalProperties: false },
        ),
        response: { 200: LIST_RESPONSE },
      },
    },
    async (request, reply) => {
      const query = request.query as { jobId?: string; candidateId?: string };
      const who = actor(request);

      /* One of the two is required. An unfiltered list would be every
         application in the tenant, which is a report and not this endpoint —
         and would page badly the moment a company has real volume. */
      if (query.jobId !== undefined) {
        await reply.send({ data: await controller.listApplicationsForJob(who, query.jobId) });
        return;
      }
      if (query.candidateId !== undefined) {
        await reply.send({
          data: await controller.listApplicationsForCandidate(who, query.candidateId),
        });
        return;
      }
      throw new BusinessRuleError('BR-055', 'Supply either jobId or candidateId.');
    },
  );
}

function registerDetail(app: FastifyInstance, options: ApplicationsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/applications/:id',
    {
      config: { findneo: { permission: 'applications.read' } },
      schema: {
        tags: ['applications'],
        security: SECURITY,
        params: ID_PARAM,
        response: { 200: ApplicationResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await reply.send(await controller.getApplication(actor(request), id));
    },
  );

  app.get(
    '/v1/applications/:id/decisions',
    {
      config: { findneo: { permission: 'applications.read' } },
      schema: {
        tags: ['applications'],
        summary: 'The decision history, newest first',
        security: SECURITY,
        params: ID_PARAM,
        response: { 200: Type.Object({ data: Type.Array(Type.Any()) }) },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await reply.send({ data: await controller.decisionHistory(actor(request), id) });
    },
  );
}

function registerReasonCatalog(app: FastifyInstance, options: ApplicationsRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/decision-reasons',
    {
      config: { findneo: { permission: 'applications.read' } },
      schema: {
        tags: ['applications'],
        summary: 'The reason catalog: the tenant’s own plus platform defaults',
        security: SECURITY,
        querystring: Type.Object(
          {
            decisionType: Type.Unsafe<string>({ type: 'string', enum: ['reject', 'hire'] }),
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ data: Type.Array(Type.Any()) }) },
      },
    },
    async (request, reply) => {
      const { decisionType } = request.query as { decisionType: string };
      await reply.send({ data: await controller.listReasons(actor(request), decisionType) });
    },
  );
}

function registerSubmission(app: FastifyInstance, options: ApplicationsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/applications',
    {
      config: { findneo: { permission: 'applications.create' } },
      schema: {
        tags: ['applications'],
        summary: 'Submit an application: snapshot frozen, resume copy enqueued',
        security: SECURITY,
        body: SubmitApplicationBody,
        response: { 201: CreatedIdResponse },
      },
    },
    async (request, reply) => {
      const created = await controller.submitApplication(
        actor(request),
        request.body as SubmitApplicationBody,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerTransfer(app: FastifyInstance, options: ApplicationsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/applications/:id/actions/transfer',
    {
      config: { findneo: { permission: 'applications.transfer' } },
      schema: {
        tags: ['applications'],
        summary: 'Transfer to another job. The source is retained, not moved (D-033)',
        security: SECURITY,
        params: ID_PARAM,
        body: TransferApplicationBody,
        response: { 201: CreatedIdResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const created = await controller.transferApplication(
        actor(request),
        id,
        request.body as TransferApplicationBody,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerWithdraw(app: FastifyInstance, options: ApplicationsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/applications/:id/actions/withdraw',
    {
      /* Withdrawal is a lifecycle change on an application the caller can
         already act on, so it rides the same permission as advancing one. */
      config: { findneo: { permission: 'applications.advance' } },
      schema: {
        tags: ['applications'],
        security: SECURITY,
        params: ID_PARAM,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await controller.withdrawApplication(actor(request), id);
      await reply.status(204).send();
    },
  );
}

function registerDecisions(app: FastifyInstance, options: ApplicationsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/applications/:id/actions/advance',
    {
      config: { findneo: { permission: 'applications.advance' } },
      schema: {
        tags: ['applications'],
        summary: 'Move to a stage of this job’s own pipeline (BR-063)',
        security: SECURITY,
        params: ID_PARAM,
        body: DecisionBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await controller.advance(actor(request), id, request.body as DecisionBody);
      await reply.status(204).send();
    },
  );
}

function registerReject(app: FastifyInstance, options: ApplicationsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/applications/:id/actions/reject',
    {
      config: { findneo: { permission: 'applications.reject' } },
      schema: {
        tags: ['applications'],
        summary: 'Reject. At least one reason is required (BR-064)',
        security: SECURITY,
        params: ID_PARAM,
        body: DecisionBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await controller.reject(actor(request), id, request.body as DecisionBody);
      await reply.status(204).send();
    },
  );
}

function registerHold(app: FastifyInstance, options: ApplicationsRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/applications/:id/actions/hold',
    {
      config: { findneo: { permission: 'applications.advance' } },
      schema: {
        tags: ['applications'],
        summary: 'Record a hold. The application stays active and stays put',
        security: SECURITY,
        params: ID_PARAM,
        body: DecisionBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await controller.hold(actor(request), id, request.body as DecisionBody);
      await reply.status(204).send();
    },
  );
}

export function registerApplicationRoutes(
  app: FastifyInstance,
  options: ApplicationsRouteOptions,
): void {
  registerReads(app, options);
  registerDetail(app, options);
  registerReasonCatalog(app, options);
  registerSubmission(app, options);
  registerTransfer(app, options);
  registerWithdraw(app, options);
  registerDecisions(app, options);
  registerReject(app, options);
  registerHold(app, options);
}
