import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { AuthController } from './auth.controller.js';
import {
  LoginBody,
  LoginResponse,
  SignupBody,
  SignupResponse,
  VerifyEmailBody,
} from './identity.schemas.js';

/**
 * Identity routes (08 §2).
 *
 * Every route carries SEC-021 metadata. These four are `public: true` with a
 * stated reason — they are the endpoints that exist to *create* a session, so
 * requiring one is circular. Absence of metadata would fail at boot, which is
 * the point: a forgotten permission breaks the build rather than opening a
 * hole.
 */

export interface IdentityRouteOptions {
  readonly controller: AuthController;
  /**
   * Development only. Registers `GET /v1/dev/last-email`, which returns the
   * verification token signup issued (08 §7). Registered nowhere else.
   */
  readonly devEmailReader?: () => unknown;
  /** Sets the refresh cookie. Injected so the module owns no cookie policy. */
  readonly setRefreshCookie: (reply: unknown, token: string) => void;
  /**
   * Called with the freshly issued verification token. Bootstrap points this
   * at the development outbox; in every other environment it is undefined and
   * the token exists only as a hash in the database.
   */
  readonly onVerificationToken?: (info: {
    companyId: string;
    userId: string;
    email: string;
    token: string;
  }) => void;
}

const PUBLIC_AUTH = {
  public: true as const,
  publicReason: 'Authentication entry point — requiring a session to obtain one is circular.',
};

function registerSignup(app: FastifyInstance, options: IdentityRouteOptions): void {
  const { controller } = options;

  app.post(
    '/v1/auth/signup',
    {
      config: { findneo: PUBLIC_AUTH },
      schema: {
        tags: ['auth'],
        summary: 'Create a company and its owner',
        body: SignupBody,
        response: { 201: SignupResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as SignupBody;
      const result = await controller.signup(body);

      options.onVerificationToken?.({
        companyId: result.companyId,
        userId: result.userId,
        email: body.email,
        token: result.verificationToken,
      });

      /* 201 and no session. The owner verifies their email and enables MFA
         before anything is issued (08 §3 step 4). The verification token is
         deliberately absent from this body — it goes to the address being
         verified, or the step proves nothing. */
      await reply.status(201).send({
        companyId: result.companyId,
        userId: result.userId,
        status: 'pending_verification',
      });
    },
  );
}

function registerLogin(app: FastifyInstance, options: IdentityRouteOptions): void {
  const { controller } = options;

  app.post(
    '/v1/auth/login',
    {
      config: { findneo: PUBLIC_AUTH },
      schema: {
        tags: ['auth'],
        summary: 'Authenticate and open a session',
        body: LoginBody,
        response: { 200: LoginResponse },
      },
    },
    async (request, reply) => {
      const result = await controller.login(request.body as LoginBody, {
        ipAddress: request.ip,
        deviceInfo: request.headers['user-agent'] ?? null,
      });

      /* The refresh token goes in an httpOnly cookie and never in the body
         (08 §3): a body value is readable by any script on the page, and a
         30-day credential readable by XSS is a 30-day account takeover. */
      options.setRefreshCookie(reply, result.refreshToken);

      await reply.status(200).send({
        accessToken: result.accessToken,
        expiresAt: result.expiresAt.toISOString(),
        user: {
          id: result.user.id,
          email: result.user.email,
          fullName: result.user.fullName,
          companyId: result.user.companyId,
        },
      });
    },
  );
}

function registerVerifyEmail(app: FastifyInstance, options: IdentityRouteOptions): void {
  const { controller } = options;

  app.post(
    '/v1/auth/verify-email',
    {
      config: { findneo: PUBLIC_AUTH },
      schema: {
        tags: ['auth'],
        summary: 'Consume an email-verification token',
        body: VerifyEmailBody,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      await controller.verifyEmail(request.body as VerifyEmailBody);
      /* 204 whether or not this was the first call. A distinguishable response
         for "already verified" tells an unauthenticated caller that an account
         exists and has been through signup. */
      await reply.status(204).send();
    },
  );
}

function registerDevEmail(app: FastifyInstance, options: IdentityRouteOptions): void {
  if (options.devEmailReader !== undefined) {
    const readDevEmail = options.devEmailReader;
    app.get(
      '/v1/dev/last-email',
      {
        config: {
          findneo: {
            public: true as const,
            publicReason:
              'Development-only helper, registered only when NODE_ENV=development. Returns the ' +
              'verification token that would otherwise arrive by email (08 §7).',
          },
        },
        schema: {
          tags: ['dev'],
          summary: 'Development only — the last verification email',
          response: { 200: Type.Any() },
        },
      },
      () => readDevEmail() ?? { message: 'No email has been sent yet.' },
    );
  }
}

export function registerIdentityRoutes(app: FastifyInstance, options: IdentityRouteOptions): void {
  registerSignup(app, options);
  registerLogin(app, options);
  registerVerifyEmail(app, options);
  registerDevEmail(app, options);
}
