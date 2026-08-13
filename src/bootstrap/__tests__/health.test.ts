import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../platform/config/config.js';
import type { Config } from '../../platform/config/config.types.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../../platform/db/unit-of-work.js';
import { createMetrics } from '../../platform/telemetry/metrics.js';
import type { UnitOfWorkPort } from '../../shared/ports/unit-of-work.js';
import { createTestDatabase, type TestDatabase } from '../../testing/harness/test-database.js';
import { buildOpsServer } from '../ops.js';

/** T-014 — health and metrics on the loopback listener (12 §3, §4). */

let database: TestDatabase;
let handle: UnitOfWorkHandle;

function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({ ...process.env, NODE_ENV: 'test', ...overrides });
}

function opsWith(uow: UnitOfWorkPort): ReturnType<typeof buildOpsServer> {
  return buildOpsServer({
    config: testConfig(),
    health: { uow, metrics: createMetrics() },
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createUnitOfWork({ url: database.appUrl, poolMax: 2, applicationName: 'health-test' });
}, 120_000);

afterAll(async () => {
  await handle.close();
  await database.drop();
});

describe('the three health endpoints (12 §4)', () => {
  it('live reports ok without touching the database', async () => {
    const { app } = opsWith(handle.uow);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('ready reports ok when the database is reachable', async () => {
    const { app } = opsWith(handle.uow);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('startup reports ok once migrations are applied', async () => {
    const { app } = opsWith(handle.uow);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/health/startup' });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

/** A pool pointed nowhere, so the check fails for a real reason. */
function brokenUow(): { uow: UnitOfWorkPort; close: () => Promise<void> } {
  const broken = createUnitOfWork({
    url: 'postgres://findneo_app:wrong@127.0.0.1:59999/findneo_missing_test',
    poolMax: 1,
    applicationName: 'health-broken',
  });
  return { uow: broken.uow, close: async () => broken.close() };
}

describe('SEC-066 / 12 §4: health endpoints expose no internal detail', () => {
  it('ready answers 503 with a status and nothing else', async () => {
    const broken = brokenUow();
    const { app } = opsWith(broken.uow);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    await app.close();
    await broken.close().catch(() => undefined);
  });

  it('the failure body names no host, port, database, driver or version', async () => {
    const broken = brokenUow();
    const { app } = opsWith(broken.uow);
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/health/ready' })).payload;

    /* These endpoints are unauthenticated and a standard reconnaissance
       target. The reason goes to the log; the caller gets a status. */
    for (const leak of ['127.0.0.1', '59999', 'findneo_missing', 'postgres', 'ECONNREFUSED']) {
      expect(body).not.toContain(leak);
    }
    await app.close();
    await broken.close().catch(() => undefined);
  });
});

describe('the failure reason reaches the operator, not the caller', () => {
  it('the reason is handed to the operator callback instead', async () => {
    const broken = brokenUow();
    let reported: string | undefined;
    const { app } = buildOpsServer({
      config: testConfig(),
      health: {
        uow: broken.uow,
        metrics: createMetrics(),
        onCheckFailed: (check) => {
          reported = check;
        },
      },
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/health/ready' });

    expect(reported).toBe('ready');
    await app.close();
    await broken.close().catch(() => undefined);
  });
});

describe('/metrics is served on the loopback listener only (12 §3)', () => {
  it('exposes Prometheus text', async () => {
    const { app } = opsWith(handle.uow);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.payload).toContain('process_cpu_user_seconds_total');
    await app.close();
  });

  it('carries no tenant label', async () => {
    const { app } = opsWith(handle.uow);
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/metrics' })).payload;
    for (const forbidden of ['companyId', 'company_id', 'tenantId']) {
      expect(body).not.toContain(forbidden);
    }
    await app.close();
  });
});
