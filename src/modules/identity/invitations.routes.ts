import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { InvitationsController } from './invitations.controller.js';
import {
  AcceptInvitationBody,
  AcceptInvitationResponse,
  CreateInvitationBody,
  CreatedInvitationResponse,
  InvitationListResponse,
  InvitationPreviewResponse,
} from './invitations.schemas.js';

/**
 * Invitation routes (08 §2).
 *
 * Two are public and two are permissioned. The public pair exists because the
 * invitee has no account yet — the token is the credential, and it is compared
 * by hash against a row nothing else can reach.
 */

export interface InvitationRouteOptions {
  readonly controller: InvitationsController;
  readonly currentUser: (request: unknown) => { companyId: string; userId: string };
}

const PUBLIC_INVITE = {
  public: true as const,
  publicReason:
    'The invitee has no account yet, so there is no session to require. The token is the ' +
    'credential and is matched by hash.',
};

function registerCreate(app: FastifyInstance, options: InvitationRouteOptions): void {
  const { controller, currentUser } = options;

  app.post(
    '/v1/invitations',
    {
      config: { findneo: { permission: 'users.invite' } },
      schema: {
        tags: ['invitations'],
        summary: 'Invite a user to this company',
        security: [{ bearerAuth: [] }],
        body: CreateInvitationBody,
        response: { 201: CreatedInvitationResponse },
      },
    },
    async (request, reply) => {
      const { companyId, userId } = currentUser(request);
      const created = await controller.create(
        companyId,
        userId,
        request.body as CreateInvitationBody,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerList(app: FastifyInstance, options: InvitationRouteOptions): void {
  const { controller, currentUser } = options;

  app.get(
    '/v1/invitations',
    {
      config: { findneo: { permission: 'users.read' } },
      schema: {
        tags: ['invitations'],
        summary: 'List this company’s invitations',
        security: [{ bearerAuth: [] }],
        response: { 200: InvitationListResponse },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      await reply.status(200).send({ data: await controller.list(companyId) });
    },
  );
}

function registerRevoke(app: FastifyInstance, options: InvitationRouteOptions): void {
  const { controller, currentUser } = options;

  app.post(
    '/v1/invitations/:id/actions/revoke',
    {
      config: { findneo: { permission: 'users.invite' } },
      schema: {
        tags: ['invitations'],
        summary: 'Revoke a pending invitation',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      await controller.revoke(companyId, (request.params as { id: string }).id);
      await reply.status(204).send();
    },
  );
}

function registerResend(app: FastifyInstance, options: InvitationRouteOptions): void {
  const { controller, currentUser } = options;

  app.post(
    '/v1/invitations/:id/actions/resend',
    {
      config: { findneo: { permission: 'users.invite' } },
      schema: {
        tags: ['invitations'],
        summary: 'Resend a pending invitation with a fresh token',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      await controller.resend(companyId, (request.params as { id: string }).id);
      await reply.status(204).send();
    },
  );
}

function registerPreview(app: FastifyInstance, options: InvitationRouteOptions): void {
  const { controller } = options;

  app.get(
    '/v1/invitations/:token',
    {
      config: { findneo: PUBLIC_INVITE },
      schema: {
        tags: ['invitations'],
        summary: 'Preview an invitation — company name only',
        params: Type.Object({ token: Type.String({ minLength: 16, maxLength: 200 }) }),
        response: { 200: InvitationPreviewResponse },
      },
    },
    async (request, reply) => {
      const preview = await controller.preview((request.params as { token: string }).token);
      await reply.status(200).send(preview);
    },
  );
}

function registerAccept(app: FastifyInstance, options: InvitationRouteOptions): void {
  const { controller } = options;

  app.post(
    '/v1/invitations/:token/accept',
    {
      config: { findneo: PUBLIC_INVITE },
      schema: {
        tags: ['invitations'],
        summary: 'Accept an invitation and create the user',
        params: Type.Object({ token: Type.String({ minLength: 16, maxLength: 200 }) }),
        body: AcceptInvitationBody,
        response: { 201: AcceptInvitationResponse },
      },
    },
    async (request, reply) => {
      const created = await controller.accept(
        (request.params as { token: string }).token,
        request.body as AcceptInvitationBody,
      );
      await reply.status(201).send(created);
    },
  );
}

export function registerInvitationRoutes(
  app: FastifyInstance,
  options: InvitationRouteOptions,
): void {
  registerCreate(app, options);
  registerList(app, options);
  registerRevoke(app, options);
  registerResend(app, options);
  /* Registered after the `/actions/*` routes so `:token` cannot shadow them —
     Fastify's router is static-first so it would not, but the ordering makes
     that independent of the router's matching rules. */
  registerPreview(app, options);
  registerAccept(app, options);
}
