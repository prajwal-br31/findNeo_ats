import Fastify, { type FastifyInstance } from 'fastify';

import type { Config } from '../platform/config/config.types.js';
import { registerHealthRoutes, type HealthDependencies } from './health.js';

/**
 * T-012 — the operational listener, bound to loopback.
 *
 * SEC-021: `/health/*` and `/metrics` are **not exempted** from the permission
 * model, they are **separated** from it. They run here, on a port that is
 * never publicly reachable, so there is no allowlist to widen later. The
 * config loader refuses a non-loopback `OPS_HOST`, so this cannot be
 * misconfigured into public reach without failing at startup.
 *
 * Documentation is an operational surface too, which is why the OpenAPI
 * document is served here rather than from the public listener — that keeps
 * SEC-021 absolute on `/v1/*` instead of carving out an exemption for `/docs`.
 *
 * One thing lands later, deliberately:
 *   - Swagger **UI**, with Phase 1's first routes. It renders nothing useful
 *     against zero routes, and wiring it now needs an unchecked cast:
 *     `app.swagger()` returns an OpenAPI 3.1 document while the plugin's
 *     static mode accepts 3.0, and under `exactOptionalPropertyTypes` those
 *     are incompatible. Recorded so it is not rediscovered.
 */

export interface OpsServer {
  readonly app: FastifyInstance;
}

export interface OpsOptions {
  readonly config: Config;
  /** Produced by the public instance, which is where the routes are. */
  readonly openApiDocument?: unknown;
  /** Omitted only in tests that exercise the listener without a database. */
  readonly health?: HealthDependencies;
}

export function buildOpsServer(options: OpsOptions): OpsServer {
  const { config, openApiDocument } = options;
  const app = Fastify({ logger: false, disableRequestLogging: true });

  /* No route metadata and no SEC-021 hook: this instance carries none of the
     permission model, because nothing on it is reachable from the internet. */
  if (options.health !== undefined) registerHealthRoutes(app, options.health);

  if (config.swagger.enabled && openApiDocument !== undefined) {
    app.get('/openapi.json', () => openApiDocument);
  }

  return { app };
}
