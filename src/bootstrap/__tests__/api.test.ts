import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../platform/config/config.js';
import type { Config } from '../../platform/config/config.types.js';
import { AppError } from '../../shared/errors/app-error.js';
import { countPublicRoutes, RouteRegistrationError } from '../../shared/http/route-metadata.js';
import type { ProblemDetails } from '../../shared/errors/problem-details.js';
import { buildApiServer } from '../api.js';
import { buildOpsServer } from '../ops.js';

/**
 * T-012. Uses Fastify's `inject`, so nothing binds a socket (11 §1).
 */

function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({ ...process.env, NODE_ENV: 'test', ...overrides });
}

/** `inject().json()` is `any`; name the shape once rather than at each use. */
function problemOf(response: { json: () => unknown }): ProblemDetails {
  return response.json() as ProblemDetails;
}

describe('SEC-021: a route without a permission fails to register', () => {
  /* The onRoute hook throws at registration, which is earlier than `ready()`
     and therefore better: the route never enters the table at all. */
  it('rejects a route declaring neither permission nor public', async () => {
    const { app } = await buildApiServer(testConfig());
    expect(() => app.get('/v1/oops', () => ({ ok: true }))).toThrow(RouteRegistrationError);
  });

  it('the failure names the route, so the boot log says which one', async () => {
    const { app } = await buildApiServer(testConfig());
    expect(() => app.get('/v1/jobs', () => ({ ok: true }))).toThrow(/GET.*\/v1\/jobs/);
  });

  it('accepts a route declaring a permission', async () => {
    const { app, routes } = await buildApiServer(testConfig());
    app.get('/v1/jobs', { config: { findneo: { permission: 'jobs.read' } } }, () => ({ ok: true }));

    await app.ready();
    expect(routes.some((route) => route.url === '/v1/jobs')).toBe(true);
    await app.close();
  });

  it('accepts an explicitly public route with a reason', async () => {
    const { app, routes } = await buildApiServer(testConfig());
    app.get(
      '/v1/public/jobs',
      { config: { findneo: { public: true, publicReason: 'career site, unauthenticated' } } },
      () => ({ ok: true }),
    );

    await app.ready();
    expect(countPublicRoutes(routes)).toBe(1);
    await app.close();
  });

  it('rejects a public route with an empty reason — absence is not a reason', async () => {
    const { app } = await buildApiServer(testConfig());
    expect(() =>
      app.get(
        '/v1/public/x',
        { config: { findneo: { public: true, publicReason: '  ' } } },
        () => ({
          ok: true,
        }),
      ),
    ).toThrow(RouteRegistrationError);
  });
});

describe('SEC-021: exemptions and counting', () => {
  it('the CORS preflight is the only exemption, and it is reported', async () => {
    const { app, exemptRoutes } = await buildApiServer(testConfig());
    app.get('/v1/a', { config: { findneo: { permission: 'a.read' } } }, () => ({}));
    await app.ready();

    /* A plugin-registered route cannot carry our metadata. Exactly one is
       exempted, by name rather than by path prefix, and it is listed here so
       an audit reads it rather than trusting a comment. */
    expect(exemptRoutes).toEqual([{ method: 'OPTIONS', url: '*' }]);
    await app.close();
  });

  it('counts public routes so CI can pin the number (SEC-021)', async () => {
    const { app, routes } = await buildApiServer(testConfig());
    app.get('/v1/a', { config: { findneo: { permission: 'a.read' } } }, () => ({}));
    app.get(
      '/v1/b',
      { config: { findneo: { public: true, publicReason: 'health of the API' } } },
      () => ({}),
    );

    await app.ready();

    /* Four entries for two endpoints: Fastify mirrors every GET with a HEAD
       that inherits its config, so the HEAD carries the same permission —
       correct, but it means the count CI pins must be of URLs, not rows. */
    expect(routes).toHaveLength(4);
    expect(new Set(routes.map((route) => route.url)).size).toBe(2);
    expect(countPublicRoutes(routes)).toBe(1);

    const mirrored = routes.filter((route) => route.method === 'HEAD');
    expect(mirrored.map((route) => route.url).sort()).toEqual(['/v1/a', '/v1/b']);
    await app.close();
  });
});

describe('errors leave as RFC 7807 with a traceId (ER-037, ER-038)', () => {
  it('an AppError maps to its catalog status and code', async () => {
    const { app } = await buildApiServer(testConfig());
    app.get('/v1/missing', { config: { findneo: { permission: 'x.read' } } }, () => {
      throw new AppError('ERR_NOT_FOUND');
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(problemOf(response)).toMatchObject({ code: 'ERR_NOT_FOUND', instance: '/v1/missing' });
    expect(problemOf(response).traceId).toBeTruthy();
    await app.close();
  });

  it('an unexpected error leaks nothing and still carries a traceId', async () => {
    const { app } = await buildApiServer(testConfig());
    app.get('/v1/boom', { config: { findneo: { permission: 'x.read' } } }, () => {
      throw new Error('constraint fk_users_company violated at C:\\app\\db.ts');
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/boom' });

    expect(response.statusCode).toBe(500);
    expect(problemOf(response).code).toBe('ERR_INTERNAL');
    expect(response.payload).not.toContain('fk_users_company');
    expect(response.payload).not.toContain('db.ts');
    expect(problemOf(response).traceId).toBeTruthy();
    await app.close();
  });
});

describe('error handling: not found and trace propagation', () => {
  it('an unknown path is a 404 problem document, not an HTML page', async () => {
    const { app } = await buildApiServer(testConfig());
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/nothing-here' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    await app.close();
  });

  it('echoes a client-supplied X-Request-Id as the traceId (07 §4)', async () => {
    const { app } = await buildApiServer(testConfig());
    app.get('/v1/x', { config: { findneo: { permission: 'x.read' } } }, () => {
      throw new AppError('ERR_CONFLICT');
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/x',
      headers: { 'x-request-id': 'client-trace-1' },
    });

    expect(problemOf(response).traceId).toBe('client-trace-1');
    await app.close();
  });
});

describe('security headers and CORS (SEC-061)', () => {
  it('sets nosniff and a referrer policy', async () => {
    const { app } = await buildApiServer(testConfig());
    app.get('/v1/x', { config: { findneo: { permission: 'x.read' } } }, () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/x' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    await app.close();
  });

  it('an empty allowlist permits no cross-origin request, and never answers *', async () => {
    const { app } = await buildApiServer(testConfig());
    app.get('/v1/x', { config: { findneo: { permission: 'x.read' } } }, () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/x',
      headers: { origin: 'https://evil.example.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('permits a configured origin', async () => {
    const { app } = await buildApiServer(
      testConfig({ CORS_ALLOWED_ORIGINS: 'https://careers.findneo.com' }),
    );
    app.get('/v1/x', { config: { findneo: { permission: 'x.read' } } }, () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/x',
      headers: { origin: 'https://careers.findneo.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('https://careers.findneo.com');
    await app.close();
  });
});

describe('the ops listener carries no permission model (SEC-021)', () => {
  it('serves the OpenAPI document when Swagger is enabled', async () => {
    const api = await buildApiServer(testConfig({ SWAGGER_ENABLED: 'true' }));
    api.app.get('/v1/jobs', { config: { findneo: { permission: 'jobs.read' } } }, () => ({}));
    await api.app.ready();

    const { app } = buildOpsServer({
      config: testConfig({ SWAGGER_ENABLED: 'true' }),
      openApiDocument: api.app.swagger(),
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);

    // Assigned to a typed local: json() is `any`, so an inline assertion reads
    // as redundant while a bare member access is unsafe.
    const document: { paths?: Record<string, unknown> } = response.json();
    expect(document.paths).toHaveProperty('/v1/jobs');

    await app.close();
    await api.app.close();
  });

  it('serves nothing when Swagger is disabled', async () => {
    const { app } = buildOpsServer({ config: testConfig({ SWAGGER_ENABLED: 'false' }) });
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(404);
    await app.close();
  });
});
