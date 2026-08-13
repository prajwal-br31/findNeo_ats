import { Client } from 'pg';
import PgBoss from 'pg-boss';

import { createQueues } from './pg-boss-queue.js';

/**
 * Installs pg-boss's schema and grants the application role access to it.
 *
 * **This is a migration-step concern, not an app-boot one.** pg-boss creates
 * its own schema, tables and per-queue partitions, which needs privileges the
 * serving role deliberately does not have — the same reasoning that keeps
 * `DATABASE_URL_MIGRATOR` out of the application config. So it runs as the
 * migrator, once, alongside the schema migrations.
 *
 * 05a §5: pg-boss owns the `pgboss` schema, its tables are outside application
 * RLS, and **access is controlled by grant instead**. This is that grant.
 */

export const QUEUE_SCHEMA = 'pgboss';

/**
 * DML but not DDL. The serving role moves jobs through their states; it never
 * creates a queue, because creating one creates a table partition.
 */
const APP_PRIVILEGES = 'SELECT, INSERT, UPDATE, DELETE';

export async function installQueueSchema(migratorUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: migratorUrl, schema: QUEUE_SCHEMA });
  await boss.start();
  await createQueues(boss);
  await boss.stop({ graceful: false });

  const client = new Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query('GRANT USAGE ON SCHEMA pgboss TO findneo_app');
    await client.query(`GRANT ${APP_PRIVILEGES} ON ALL TABLES IN SCHEMA pgboss TO findneo_app`);
    await client.query('GRANT USAGE ON ALL SEQUENCES IN SCHEMA pgboss TO findneo_app');
    /* Partitions are created per queue, after this runs. Without a default
       privilege a queue added later would be invisible to the worker — and
       the failure would look like "no jobs" rather than "no permission". */
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ${APP_PRIVILEGES} ON TABLES TO findneo_app`,
    );
  } finally {
    await client.end();
  }
}
