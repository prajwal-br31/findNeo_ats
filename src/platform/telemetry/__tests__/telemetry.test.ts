import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../config/config.js';
import type { Config } from '../../config/config.types.js';
import { createLogger } from '../logger.js';
import { MetricLabelError, assertNoTenantLabel, createMetrics } from '../metrics.js';
import { REDACTED, redactDeep } from '../redaction.js';
import { startTracing } from '../tracing.js';

/** T-014 — logging, metrics and tracing (12 §1–3). */

function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({ ...process.env, NODE_ENV: 'test', ...overrides });
}

function captureLines(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { stream, lines };
}

describe('ER-048 / SEC-033: personal data never reaches a log line', () => {
  const personal = {
    email: 'candidate@example.com',
    phone: '+44 7700 900000',
    fullName: 'Ada Lovelace',
    salaryMin: '90000',
    expectedCtc: '120000',
    rawText: 'the full resume text',
    comments: 'strong hire, reservations about…',
    password: 'hunter2',
    refreshToken: 'rt_abc',
    mfaSecret: 'JBSWY3DP',
  };

  it.each(Object.keys(personal))('redacts %s at the top level', (key) => {
    const redacted = redactDeep(personal) as Record<string, unknown>;
    expect(redacted[key]).toBe(REDACTED);
  });

  it('redacts at any depth, which a path pattern cannot', () => {
    /* `*.email` matches one level down. Real payloads nest further, and the
       whole point of a backstop is catching what nobody predicted. */
    const nested = { a: { b: { c: { candidate: { email: 'deep@example.com' } } } } };
    expect(JSON.stringify(redactDeep(nested))).not.toContain('deep@example.com');
  });

  it('redacts inside arrays', () => {
    const list = { candidates: [{ email: 'one@example.com' }, { email: 'two@example.com' }] };
    const serialized = JSON.stringify(redactDeep(list));
    expect(serialized).not.toContain('one@example.com');
    expect(serialized).not.toContain('two@example.com');
  });

  it('redacts snake_case row keys, since a row is what gets logged by accident', () => {
    const row = {
      full_name: 'Ada Lovelace',
      expected_ctc: '120000',
      password_hash: 'argon2id$v=19$secret',
    };
    const serialized = JSON.stringify(redactDeep(row));
    for (const value of ['Ada Lovelace', '120000', 'argon2id']) {
      expect(serialized).not.toContain(value);
    }
  });
});

describe('redaction keeps what is safe, and reaches real output', () => {
  it('leaves ids and non-personal fields intact — a redactor that eats everything is useless', () => {
    const entry = { companyId: '0192f', jobId: 'job-1', statusCode: 200, route: '/v1/jobs' };
    expect(redactDeep(entry)).toEqual(entry);
  });

  it('the logger applies it to real output', () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({ config: testConfig(), destination: stream });

    logger.error({ candidate: { profile: { email: 'leak@example.com' } } }, 'request failed');

    expect(lines.join('')).not.toContain('leak@example.com');
    expect(lines.join('')).toContain(REDACTED);
  });

  it('the logger still emits the fields 12 §1 requires', () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({ config: testConfig(), destination: stream });

    logger.info(
      { traceId: 't-1', companyId: 'c-1', route: '/v1/jobs', statusCode: 200, durationMs: 12 },
      'ok',
    );

    const entry = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(entry).toMatchObject({ traceId: 't-1', companyId: 'c-1', statusCode: 200 });
    expect(entry['level']).toBe('info');
    expect(entry['time']).toBeTruthy();
  });
});

describe('12 §3: metrics are never labelled by tenant', () => {
  it('rejects a companyId label at construction', () => {
    expect(() => {
      assertNoTenantLabel('jobs_total', ['route', 'companyId']);
    }).toThrow(MetricLabelError);
  });

  it.each(['company_id', 'tenant', 'tenantId', 'userId', 'email'])(
    'rejects %s too — unbounded cardinality takes the backend down',
    (label) => {
      expect(() => {
        assertNoTenantLabel('x_total', [label]);
      }).toThrow(MetricLabelError);
    },
  );

  it('permits bounded labels', () => {
    expect(() => {
      assertNoTenantLabel('http_requests_total', ['route', 'method', 'status']);
    }).not.toThrow();
  });

  it('the registry exposes Prometheus text', async () => {
    const metrics = createMetrics();
    metrics.httpRequests.inc({ route: '/v1/jobs', method: 'GET', status: '200' });

    const exposed = await metrics.registry.metrics();
    expect(exposed).toContain('http_requests_total');
    expect(metrics.registry.contentType).toContain('text/plain');
  });

  it('no registered metric carries a tenant label', async () => {
    /* Control-integrity (11 §3a): asserted against the live registry, not
       against the constructor that built it. */
    const exposed = await createMetrics().registry.metrics();
    for (const forbidden of ['companyId', 'company_id', 'tenantId']) {
      expect(exposed).not.toContain(forbidden);
    }
  });
});

describe('SEC-070: telemetry does not egress by default', () => {
  it('is disabled when OTEL_ENABLED is false', () => {
    const handle = startTracing(testConfig({ OTEL_ENABLED: 'false' }));
    expect(handle.enabled).toBe(false);
  });

  it('shutting down a disabled tracer is safe', async () => {
    await expect(
      startTracing(testConfig({ OTEL_ENABLED: 'false' })).shutdown(),
    ).resolves.toBeUndefined();
  });

  it('the config refuses OTEL_ENABLED=true without an endpoint', () => {
    /* There is no default collector. An enabled exporter with nowhere to send
       would either drop spans silently or reach for a vendor default — and
       "nothing phones home" is the on-premise promise. */
    expect(() => testConfig({ OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toThrow();
  });
});
