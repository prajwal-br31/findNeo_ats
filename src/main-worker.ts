import PgBoss from 'pg-boss';

import { buildContainer } from './bootstrap/container.js';
import { buildRegistry, startWorkers, type JobHandler } from './bootstrap/worker.js';
import { createResumeCopyHandler } from './workers/documents/resume-copy.handler.js';
import { loadConfig } from './platform/config/config.js';
import { createLogger } from './platform/telemetry/logger.js';
import { startTracing } from './platform/telemetry/tracing.js';

/**
 * The worker process (D-003 — one package, two bootstraps).
 *
 * Serves the domains in `WORKER_DOMAINS`: one process per domain in
 * production, all six in one on-premise. Configuration, not a code path.
 *
 * The registry is empty in Phase 0 — there are no jobs yet. That is not a
 * placeholder to fill in later so much as the point: the process must start,
 * connect, register its pools and shut down cleanly *before* anything depends
 * on it, so the first real handler lands on proven wiring.
 *
 * pg-boss is started with `migrate: false`. Installing its schema is a
 * migration-step concern (`pnpm db:migrate`) because it needs DDL rights the
 * serving role deliberately does not have (05a §5).
 */

const config = loadConfig(process.env);
const logger = createLogger({ config });
const tracing = startTracing(config);
const container = await buildContainer(config);

const boss = new PgBoss({
  connectionString: config.database.url,
  schema: 'pgboss',
  migrate: false,
  application_name: `findneo-worker-${config.nodeEnv}`,
});

boss.on('error', (error) => {
  logger.error({ err: error }, 'pg-boss error');
});

await boss.start();

const fleet = await startWorkers({
  boss,
  uow: container.uow,
  config,
  /* One job so far. `documents` because copying an object is document work
     and not recruitment logic — an AI ranking job queued behind a 10 MB copy
     is exactly the starvation the domain split exists to prevent (ER-041a). */
  registry: buildRegistry({
    /* The double assertion is the seam between a narrowly-typed handler and
       the registry's erased `TenantJobPayload`. The fleet reads the payload
       from the job row, so no compiler can prove the shapes agree — the
       registry name is the contract, and it is asserted here, once, in the
       one file allowed to know both sides. */
    documents: {
      'resume.copy_for_application': createResumeCopyHandler(
        container.resumeCopy,
      ) as unknown as JobHandler,
    },
  }),
  onJobError: (domain, jobName, error) => {
    /* Ids and names only. A job payload carries `companyId` and other
       identifiers, and ER-048 does not exempt an error path from the rule
       against logging personal data. */
    logger.error({ domain, jobName, err: error }, 'job failed');
  },
});

logger.info({ domains: fleet.domains }, 'findneo worker listening');

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  try {
    /* Graceful: finish the jobs already claimed rather than abandoning them
       to their expiry timeout, which would delay redelivery by minutes. */
    await fleet.stop();
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
