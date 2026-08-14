import { buildApiServer } from './bootstrap/api.js';
import { buildContainer } from './bootstrap/container.js';
import { buildOpsServer } from './bootstrap/ops.js';
import { loadConfig } from './platform/config/config.js';
import { readLastDevEmail, recordDevEmail } from './platform/mail/dev-outbox.js';
import { createLogger } from './platform/telemetry/logger.js';
import { createMetrics } from './platform/telemetry/metrics.js';
import { startTracing } from './platform/telemetry/tracing.js';

/**
 * The API process (D-003 — one package, two bootstraps).
 *
 * Two listeners, deliberately:
 *
 *  - the **public** one on `API_HOST:API_PORT`, carrying the whole permission
 *    model, and
 *  - the **operational** one on `OPS_HOST:OPS_PORT`, loopback-only, carrying
 *    `/health/*`, `/metrics` and the OpenAPI document.
 *
 * SEC-021: health and metrics are not *exempted* from the permission model,
 * they are *separated* from it — there is no allowlist here to widen later,
 * and the config loader refuses a non-loopback `OPS_HOST` so this cannot be
 * misconfigured into public reach without failing at startup.
 *
 * Nothing here decides anything. Composition only: load config, build the
 * container, listen, and shut down in the reverse order.
 */

const config = loadConfig(process.env);
const logger = createLogger({ config });
const tracing = startTracing(config);
const metrics = createMetrics();
const container = await buildContainer(config);

/* The development outbox is wired only in development, and the route that
   reads it is registered under the same condition (08 §7). Two guards rather
   than one, because either alone is the kind of thing a refactor removes. */
const isDevelopment = config.nodeEnv === 'development';

const api = await buildApiServer(config, {
  authController: container.authController,
  invitationsController: container.invitationsController,
  accessController: container.accessController,
  permissionsService: container.permissionsService,
  jobsController: container.jobsController,
  fieldVisibility: container.fieldVisibility,
  usersService: container.usersService,
  tokenVerifier: container.tokenVerifier,
  logger,
  ...(isDevelopment
    ? {
        captureVerificationToken: (info) => {
          recordDevEmail({
            to: info.email,
            template: 'email.verification',
            token: info.token,
            companyId: info.companyId,
            userId: info.userId,
            capturedAt: new Date().toISOString(),
          });
        },
        readLastEmail: readLastDevEmail,
      }
    : {}),
});

/* `.swagger()` reads the registered route table, which does not exist until
   the plugin tree is built — so `ready()` first, or it throws. Doing it here
   rather than lazily also means a malformed schema fails at startup instead of
   the first time someone opens the document. */
await api.app.ready();

const ops = buildOpsServer({
  config,
  openApiDocument: config.swagger.enabled ? api.app.swagger() : undefined,
  health: {
    uow: container.uow,
    metrics,
    onCheckFailed: (check, error) => {
      /* The reason is logged and never returned: a health response that
         explains *why* it is unhealthy tells an unauthenticated caller about
         internals (12 §3). */
      logger.error({ check, err: error }, 'health check failed');
    },
  },
});

await api.app.listen({ host: config.api.host, port: config.api.port });
await ops.app.listen({ host: config.ops.host, port: config.ops.port });

logger.info(
  {
    api: `${config.api.host}:${String(config.api.port)}`,
    ops: `${config.ops.host}:${String(config.ops.port)}`,
    routes: api.routes.length,
    /* Zero in Phase 0, and worth printing: a non-zero count here before Phase
       1 means something registered a public route without route metadata. */
    exemptRoutes: api.exemptRoutes.length,
  },
  'findneo api listening',
);

/**
 * Graceful shutdown. Stop accepting connections, drain in-flight requests,
 * then close the pool — in that order, so a request already in a transaction
 * is not cut off from its connection mid-commit.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  try {
    await api.app.close();
    await ops.app.close();
    await container.close();
    await tracing.shutdown();
    logger.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}
