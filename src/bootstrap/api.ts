import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import underPressure from '@fastify/under-pressure';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

import type { Config } from '../platform/config/config.types.js';
import { describeForLog, toProblemDetails } from '../shared/errors/problem-details.js';
import {
  assertRouteMetadata,
  isCorsPreflightRoute,
  type RegisteredRoute,
  type RouteConfig,
} from '../shared/http/route-metadata.js';

/**
 * T-012 — the public listener. Serves `/v1/*` and `/bff/web/*` (AGENTS.md §4).
 *
 * `/health/*` and `/metrics` are **not** here. They run on a second instance
 * bound to loopback (`ops.ts`), which is how SEC-021 keeps operational
 * endpoints out of the permission model structurally rather than by allowlist.
 */

/** Authenticated general limit (07 §10). Per-surface limits ship with routes. */
const AUTHENTICATED_RATE_LIMIT = 300;
const RATE_LIMIT_WINDOW = '1 minute';

export interface ApiServer {
  readonly app: FastifyInstance;
  /** Every route registered, for the SEC-021 public-route count. */
  readonly routes: readonly RegisteredRoute[];
  /**
   * Routes exempt from the permission model — the CORS preflight, and nothing
   * else. Surfaced so an audit reads the list rather than trusting a comment.
   */
  readonly exemptRoutes: readonly { readonly method: string; readonly url: string }[];
}

function registerSecurity(app: FastifyInstance, config: Config): void {
  void app.register(helmet, {
    // 07 §1: HTTPS only, HSTS on. Disabled in development, where there is no TLS.
    hsts: config.nodeEnv === 'production' || config.nodeEnv === 'staging',
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  /* Never `*` on a credentialed route (SEC-061). An empty allowlist means no
     cross-origin request is permitted, which is the correct posture until
     Phase 4 names the career-page origin (D-043). */
  void app.register(cors, {
    origin: config.corsAllowedOrigins.length === 0 ? false : [...config.corsAllowedOrigins],
    credentials: true,
  });

  void app.register(cookie, { secret: config.auth.cookieSecret });

  void app.register(rateLimit, {
    max: AUTHENTICATED_RATE_LIMIT,
    timeWindow: RATE_LIMIT_WINDOW,
    // Per-instance counters in v1 (07 §10, D-017). Distributed limiting is a
    // hosted-product decision, never a requirement pushed onto on-premise.
    hook: 'onRequest',
  });

  void app.register(underPressure, {
    maxEventLoopDelay: 1000,
    // Sheds load predictably rather than degrading unpredictably (SEC-066).
    retryAfter: 5,
  });
}

/**
 * One place turns an exception into a response (ER-037, ER-038).
 *
 * The full cause goes to the log against the traceId; the client gets the code
 * and the traceId and nothing else.
 */
function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const traceId = request.id;
    const problem = toProblemDetails(error, { instance: request.url, traceId });

    if (problem.status >= 500) {
      request.log.error({ traceId, err: describeForLog(error) }, 'request failed');
    }

    void reply.status(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = toProblemDetails(Object.assign(new Error('not found'), { name: 'NotFound' }), {
      instance: request.url,
      traceId: request.id,
    });
    void reply
      .status(404)
      .type('application/problem+json')
      .send({ ...problem, status: 404 });
  });
}

export async function buildApiServer(config: Config): Promise<ApiServer> {
  const routes: RegisteredRoute[] = [];
  const exempt: { method: string; url: string }[] = [];

  const app = Fastify({
    // X-Request-Id in, echoed out (07 §4). Generated when absent.
    genReqId: (request) => (request.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    trustProxy: config.nodeEnv === 'production' || config.nodeEnv === 'staging',
    disableRequestLogging: true,
    logger: false,
  });

  /* SEC-021, enforced at boot. A route without metadata throws here, which
     fails `app.ready()` — the build breaks rather than the endpoint leaking. */
  app.addHook('onRoute', (route) => {
    const method = route.method.toString();
    const metadata = (route.config as RouteConfig | undefined)?.findneo;
    assertRouteMetadata(method, route.url, metadata);
    if (isCorsPreflightRoute(method, route.url)) {
      exempt.push({ method, url: route.url });
      return;
    }
    if (metadata !== undefined) routes.push({ method, url: route.url, metadata });
  });

  /* Awaited, and registered before anything else that adds routes:
     @fastify/swagger collects routes through its own onRoute hook, which only
     sees routes registered after the plugin has loaded. Registered lazily it
     documents nothing, silently — the generated document was empty until a
     test asserted a path was in it.

     It adds no routes of its own, so it does not collide with SEC-021. The UI
     is served from the ops listener (07 §7, 12 §10). */
  await app.register(swagger, {
    openapi: {
      info: { title: 'FindNeo API', version: '1' },
      servers: [{ url: `http://${config.api.host}:${String(config.api.port)}` }],
    },
  });

  registerSecurity(app, config);
  registerErrorHandling(app);

  return { app, routes, exemptRoutes: exempt };
}
