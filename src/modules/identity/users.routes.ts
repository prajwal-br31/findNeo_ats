import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { unsafeCompanyId, unsafeUserId } from '../../shared/types/ids.js';

import type { UsersService } from './application/users.service.js';

/**
 * `GET /v1/users/current` and `GET /v1/users`.
 *
 * Separate from `access.routes.ts` because these two are what the client boots
 * from — the profile drives nav and every guard, and the list backs three
 * different pickers. Keeping them in their own file makes that dependency
 * visible rather than buried among role administration.
 */

export interface UsersRouteOptions {
  readonly service: UsersService;
  readonly currentUser: (request: unknown) => {
    companyId: string;
    userId: string;
    capability: number;
  };
}

const SECURITY = [{ bearerAuth: [] }];

const CurrentUserResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    email: Type.String(),
    fullName: Type.String(),
    companyId: Type.String({ format: 'uuid' }),
    companyName: Type.String(),
    status: Type.String(),
    mfaEnabled: Type.Boolean(),
    roles: Type.Array(Type.String()),
    /* Resolved per request, never carried in the token (SEC-013). */
    permissions: Type.Array(Type.String()),
    departments: Type.Array(
      Type.Object(
        {
          id: Type.String({ format: 'uuid' }),
          name: Type.String(),
          isPrimary: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    capability: Type.Integer(),
  },
  { additionalProperties: false },
);

const UserListResponse = Type.Object(
  {
    data: Type.Array(
      Type.Object(
        {
          id: Type.String({ format: 'uuid' }),
          email: Type.String(),
          fullName: Type.String(),
          phone: Type.Union([Type.String(), Type.Null()]),
          status: Type.String(),
          roles: Type.Array(Type.String()),
          departments: Type.Array(Type.String()),
          lastLoginAt: Type.Union([Type.String(), Type.Null()]),
          createdAt: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
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

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Mapped explicitly (ER-025): `roleKeys` and `departmentNames` are the query's
 * shape, `roles` and `departments` are the contract's.
 */
function toListItem(row: {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: string;
  roleKeys: string[];
  departmentNames: string[];
  lastLoginAt: Date | string | null;
  createdAt: Date | string;
}): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    phone: row.phone,
    status: row.status,
    roles: row.roleKeys,
    departments: row.departmentNames,
    lastLoginAt: toIso(row.lastLoginAt),
    createdAt: toIso(row.createdAt) ?? '',
  };
}

function registerCurrent(app: FastifyInstance, options: UsersRouteOptions): void {
  const { service, currentUser } = options;

  app.get(
    '/v1/users/current',
    {
      /* Authenticated, but no permission: reading your own profile is not
         something a role grants you, and gating it would let an
         over-restricted role lock a user out of the app entirely. */
      config: { findneo: { permission: 'self' } },
      schema: {
        tags: ['users'],
        summary: 'The authenticated caller, with permissions resolved fresh',
        security: SECURITY,
        response: { 200: CurrentUserResponse },
      },
    },
    async (request, reply) => {
      const { companyId, userId, capability } = currentUser(request);
      const me = await service.current(
        unsafeCompanyId(companyId),
        unsafeUserId(userId),
        capability,
      );
      await reply.send(me);
    },
  );
}

function registerList(app: FastifyInstance, options: UsersRouteOptions): void {
  const { service, currentUser } = options;

  app.get(
    '/v1/users',
    {
      config: { findneo: { permission: 'users.read' } },
      schema: {
        tags: ['users'],
        summary: 'The tenant’s users, cursor paginated',
        security: SECURITY,
        querystring: Type.Object(
          {
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            cursor: Type.Optional(Type.String({ maxLength: 400 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: UserListResponse },
      },
    },
    async (request, reply) => {
      const { companyId } = currentUser(request);
      const query = request.query as { limit?: number; cursor?: string };

      const page = await service.list(unsafeCompanyId(companyId), {
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });

      await reply.send({ data: page.data.map(toListItem), pagination: page.pagination });
    },
  );
}

export function registerUserRoutes(app: FastifyInstance, options: UsersRouteOptions): void {
  /* `/v1/users/current` before `/v1/users/:id`-shaped routes elsewhere, so a
     literal segment is never shadowed by a parameter. */
  registerCurrent(app, options);
  registerList(app, options);
}
