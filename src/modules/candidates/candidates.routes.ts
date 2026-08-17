import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { CandidatesController, RequestActor } from './candidates.controller.js';
import {
  CandidateResponse,
  CreateCandidateBody,
  CreatedIdResponse,
  DuplicateMatch,
  UpdateCandidateBody,
} from './candidates.schemas.js';
import { MAX_RESUME_BYTES } from './resume-content.js';

/** `/v1/candidates/*` — profiles, duplicate checks and resumes (T-062, T-064). */

export interface CandidatesRouteOptions {
  readonly controller: CandidatesController;
  readonly actor: (request: unknown) => RequestActor;
}

const SECURITY = [{ bearerAuth: [] }];
const ID_PARAM = Type.Object({ id: Type.String({ format: 'uuid' }) });

const CANDIDATE_PAGE = Type.Object(
  {
    data: Type.Array(CandidateResponse),
    pagination: Type.Object(
      {
        nextCursor: Type.Optional(Type.String()),
        hasMore: Type.Boolean(),
        limit: Type.Integer(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/**
 * The upload route takes the file as the raw request body.
 *
 * No multipart: it would mean a new runtime dependency for a single endpoint,
 * and the form fields it exists to carry are not needed here — the filename
 * arrives in a header and every other property of the file is derived from
 * its bytes. The parser hands the handler a Buffer and validates nothing,
 * deliberately: `detectResumeContentType` is the only thing allowed to decide
 * what this file is.
 */
function registerOctetStreamParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_RESUME_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );
}

function registerReads(app: FastifyInstance, options: CandidatesRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/candidates',
    {
      config: { findneo: { permission: 'candidates.read' } },
      schema: {
        tags: ['candidates'],
        summary: 'The tenant’s candidates, cursor paginated',
        security: SECURITY,
        querystring: Type.Object(
          {
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            cursor: Type.Optional(Type.String({ maxLength: 400 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: CANDIDATE_PAGE },
      },
    },
    async (request, reply) => {
      const query = request.query as { limit?: number; cursor?: string };
      await reply.send(await controller.listCandidates(actor(request), query));
    },
  );
}

function registerCandidateDetail(app: FastifyInstance, options: CandidatesRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/candidates/:id',
    {
      config: { findneo: { permission: 'candidates.read' } },
      schema: {
        tags: ['candidates'],
        security: SECURITY,
        params: ID_PARAM,
        response: { 200: CandidateResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await reply.send(await controller.getCandidate(actor(request), id));
    },
  );
}

function registerDuplicateCheck(app: FastifyInstance, options: CandidatesRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/candidates/actions/check-duplicates',
    {
      /* A read against the candidate table by another name, so it takes the
         read permission — not the create one. Someone who may not read
         candidates must not learn who exists by probing this. */
      config: { findneo: { permission: 'candidates.read' } },
      schema: {
        tags: ['candidates'],
        summary: 'Possible duplicates for a name and email, before creating',
        security: SECURITY,
        querystring: Type.Object(
          {
            fullName: Type.String({ minLength: 1, maxLength: 200 }),
            email: Type.Optional(Type.String({ maxLength: 254 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ data: Type.Array(DuplicateMatch) }) },
      },
    },
    async (request, reply) => {
      const query = request.query as { fullName: string; email?: string };
      const data = await controller.findDuplicates(actor(request), query.fullName, query.email);
      await reply.send({ data });
    },
  );
}

function registerWrites(app: FastifyInstance, options: CandidatesRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/candidates',
    {
      config: { findneo: { permission: 'candidates.create' } },
      schema: {
        tags: ['candidates'],
        summary: 'Create a candidate; possible duplicates are reported, never merged',
        security: SECURITY,
        body: CreateCandidateBody,
        response: {
          201: Type.Object(
            {
              id: Type.String({ format: 'uuid' }),
              /* Advisory (BR-061). The candidate was created regardless. */
              possibleDuplicates: Type.Array(DuplicateMatch),
            },
            { additionalProperties: false },
          ),
        },
      },
    },
    async (request, reply) => {
      const created = await controller.createCandidate(
        actor(request),
        request.body as CreateCandidateBody,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerUpdate(app: FastifyInstance, options: CandidatesRouteOptions): void {
  const { controller, actor } = options;

  app.patch(
    '/v1/candidates/:id',
    {
      config: { findneo: { permission: 'candidates.update' } },
      schema: {
        tags: ['candidates'],
        summary: 'Update the mutable profile. Existing application snapshots are untouched',
        security: SECURITY,
        params: ID_PARAM,
        body: UpdateCandidateBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await controller.updateCandidate(actor(request), id, request.body as UpdateCandidateBody);
      await reply.status(204).send();
    },
  );
}

function registerResumes(app: FastifyInstance, options: CandidatesRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/candidates/:id/resumes',
    {
      config: { findneo: { permission: 'candidates.read' } },
      schema: {
        tags: ['candidates'],
        security: SECURITY,
        params: ID_PARAM,
        response: { 200: Type.Object({ data: Type.Array(Type.Any()) }) },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await reply.send({ data: await controller.listResumes(actor(request), id) });
    },
  );
}

function registerResumeUpload(app: FastifyInstance, options: CandidatesRouteOptions): void {
  const { controller, actor } = options;

  app.post(
    '/v1/candidates/:id/resumes',
    {
      config: { findneo: { permission: 'candidates.update' } },
      schema: {
        tags: ['candidates'],
        summary: 'Upload a resume as the raw body; the type is read from its bytes',
        security: SECURITY,
        params: ID_PARAM,
        response: { 201: Type.Object({ id: Type.String(), contentType: Type.String() }) },
      },
      bodyLimit: MAX_RESUME_BYTES,
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      /* Display only, and never part of a storage key (SEC-043). Sanitised
         here because it is echoed back to a browser on download. */
      const header = request.headers['x-filename'];
      const filename = sanitiseFilename(typeof header === 'string' ? header : 'resume');

      const created = await controller.uploadResume(
        actor(request),
        id,
        request.body as Buffer,
        filename,
      );
      await reply.status(201).send(created);
    },
  );
}

function registerResumeDownload(app: FastifyInstance, options: CandidatesRouteOptions): void {
  const { controller, actor } = options;

  app.get(
    '/v1/resumes/:id/content',
    {
      config: { findneo: { permission: 'applications.resume.download' } },
      schema: {
        tags: ['candidates'],
        summary: 'The resume bytes',
        security: SECURITY,
        params: ID_PARAM,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const file = await controller.downloadResume(actor(request), id);
      /* `attachment` so a PDF with embedded script never renders in the
         tenant's own origin, and the quoted name so a comma cannot split the
         header. */
      await reply
        .header('content-type', file.contentType)
        .header('content-disposition', `attachment; filename="${file.filename}"`)
        .send(file.bytes);
    },
  );
}

/** Strips anything that could confuse a header or a filesystem. */
function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, '_').slice(0, 200);
  return cleaned.trim() === '' ? 'resume' : cleaned;
}

export function registerCandidateRoutes(
  app: FastifyInstance,
  options: CandidatesRouteOptions,
): void {
  registerOctetStreamParser(app);
  /* The literal `actions/check-duplicates` is registered before `:id` so the
     parameter cannot shadow it. */
  registerDuplicateCheck(app, options);
  registerReads(app, options);
  registerCandidateDetail(app, options);
  registerWrites(app, options);
  registerUpdate(app, options);
  registerResumes(app, options);
  registerResumeUpload(app, options);
  registerResumeDownload(app, options);
}

export { CreatedIdResponse };
