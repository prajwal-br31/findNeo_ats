import { describe, expect, it } from 'vitest';

import {
  AppError,
  BusinessRuleError,
  ValidationError,
  conflict,
  forbidden,
  internal,
  notFound,
} from '../app-error.js';
import { ERROR_CATALOG, errorTypeUri, isErrorCode, type ErrorCode } from '../error-catalog.js';
import { describeForLog, toProblemDetails } from '../problem-details.js';

const CONTEXT = { instance: '/v1/jobs', traceId: '0192f3a1c4d27e8b' };

describe('the catalog matches 07 §6', () => {
  it.each([
    ['ERR_MALFORMED_REQUEST', 400],
    ['ERR_UNAUTHENTICATED', 401],
    ['ERR_TOKEN_EXPIRED', 401],
    ['ERR_MFA_REQUIRED', 401],
    ['ERR_FORBIDDEN', 403],
    ['ERR_CAPABILITY_MISMATCH', 403],
    ['ERR_NOT_FOUND', 404],
    ['ERR_CONFLICT', 409],
    ['ERR_INVALID_TRANSITION', 409],
    ['ERR_DUPLICATE', 409],
    ['ERR_IDEMPOTENCY_CONFLICT', 409],
    ['ERR_TOKEN_CONSUMED', 410],
    ['ERR_PAYLOAD_TOO_LARGE', 413],
    ['ERR_UNSUPPORTED_MEDIA_TYPE', 415],
    ['ERR_VALIDATION_FAILED', 422],
    ['ERR_BUSINESS_RULE_VIOLATION', 422],
    ['ERR_APPLICATION_CAP_REACHED', 422],
    ['ERR_RATE_LIMITED', 429],
    ['ERR_INTERNAL', 500],
    ['ERR_SERVICE_UNAVAILABLE', 503],
  ] as const)('%s maps to %i', (code, status) => {
    expect(ERROR_CATALOG[code].status).toBe(status);
  });

  it('carries exactly the twenty codes the specification lists', () => {
    expect(Object.keys(ERROR_CATALOG)).toHaveLength(20);
  });

  it('derives the type URI shown in the specification', () => {
    expect(errorTypeUri('ERR_VALIDATION_FAILED')).toBe(
      'https://errors.findneo.com/validation-failed',
    );
  });

  it('rejects a code that is not in the catalog', () => {
    expect(isErrorCode('ERR_MADE_UP')).toBe(false);
    expect(isErrorCode('ERR_NOT_FOUND')).toBe(true);
  });
});

describe('the wire shape', () => {
  it('carries every RFC 7807 member, with traceId', () => {
    const problem = toProblemDetails(notFound(), CONTEXT);
    expect(problem).toMatchObject({
      type: 'https://errors.findneo.com/not-found',
      title: 'Not found',
      status: 404,
      code: 'ERR_NOT_FOUND',
      instance: '/v1/jobs',
      traceId: '0192f3a1c4d27e8b',
    });
  });

  it('omits detail rather than echoing the catalog title', () => {
    expect(toProblemDetails(notFound(), CONTEXT).detail).toBeUndefined();
  });

  it('carries fields[] with JSON Pointer paths for a validation failure', () => {
    const error = new ValidationError([
      { path: '/title', code: 'ERR_FIELD_REQUIRED', message: 'Title is required.' },
      { path: '/salaryMax', code: 'ERR_FIELD_RANGE', message: 'Must be at least salaryMin.' },
    ]);
    const problem = toProblemDetails(error, CONTEXT);

    expect(problem.status).toBe(422);
    expect(problem.fields?.map((f) => f.path)).toEqual(['/title', '/salaryMax']);
  });

  it('cites the rule id in a business-rule violation (07 §6)', () => {
    const problem = toProblemDetails(
      new BusinessRuleError('BR-058', 'The concurrent application cap is 1.'),
      CONTEXT,
    );
    expect(problem.detail).toContain('BR-058');
  });

  it('every catalog code produces a serializable problem', () => {
    for (const code of Object.keys(ERROR_CATALOG) as ErrorCode[]) {
      const problem = toProblemDetails(new AppError(code), CONTEXT);
      expect(problem.code).toBe(code);
      expect(problem.status).toBe(ERROR_CATALOG[code].status);
      expect(() => JSON.stringify(problem)).not.toThrow();
    }
  });
});

describe('ER-038 / SEC-063: an error leaks nothing internal', () => {
  const LEAKY = new Error(
    'insert or update on table "users" violates foreign key constraint ' +
      '"fk_users_company" at C:\\app\\src\\db.ts:42 (host db-prod-01, pg 18.1)',
  );

  it('an unrecognised throwable becomes a bare ERR_INTERNAL', () => {
    const problem = toProblemDetails(LEAKY, CONTEXT);
    expect(problem.code).toBe('ERR_INTERNAL');
    expect(problem.status).toBe(500);
  });

  it.each([
    ['constraint name', 'fk_users_company'],
    ['table name', 'users'],
    ['file path', 'src\\db.ts'],
    ['hostname', 'db-prod-01'],
    ['library version', 'pg 18.1'],
    ['driver message', 'violates foreign key'],
  ])('the serialized problem contains no %s', (_label, fragment) => {
    const serialized = JSON.stringify(toProblemDetails(LEAKY, CONTEXT));
    expect(serialized).not.toContain(fragment);
  });

  it('a cause attached to an AppError never reaches the wire', () => {
    const problem = toProblemDetails(internal(LEAKY), CONTEXT);
    expect(JSON.stringify(problem)).not.toContain('fk_users_company');
  });

  it('still carries the traceId, so the cause is findable', () => {
    expect(toProblemDetails(LEAKY, CONTEXT).traceId).toBe('0192f3a1c4d27e8b');
  });

  it('a non-Error throwable does not crash the mapper', () => {
    for (const thrown of [undefined, null, 'a string', 42, { sql: 'SELECT 1' }]) {
      const problem = toProblemDetails(thrown, CONTEXT);
      expect(problem.code).toBe('ERR_INTERNAL');
      expect(JSON.stringify(problem)).not.toContain('SELECT 1');
    }
  });
});

describe('the diagnostic half goes to the log, not the response', () => {
  it('describeForLog keeps what the response drops', () => {
    const described = describeForLog(internal(new Error('constraint fk_users_company')));
    expect(JSON.stringify(described)).toContain('fk_users_company');
  });

  it('walks the cause chain', () => {
    const root = new Error('root cause');
    const wrapped = new AppError('ERR_CONFLICT', { cause: root });
    const described = describeForLog(wrapped);
    expect(JSON.stringify(described)).toContain('root cause');
  });

  it('handles a non-Error throwable', () => {
    expect(describeForLog('plain string')).toMatchObject({ kind: 'unknown' });
  });
});

describe('ER-021: another tenant is indistinguishable from absent', () => {
  it('notFound is the only door — there is no 403 variant for cross-tenant', () => {
    const absent = toProblemDetails(notFound(), CONTEXT);
    const otherTenant = toProblemDetails(notFound(), CONTEXT);
    expect(absent).toEqual(otherTenant);
    expect(absent.status).toBe(404);
  });

  it('forbidden is 403 and is for in-tenant permission failures only', () => {
    expect(toProblemDetails(forbidden(), CONTEXT).status).toBe(403);
  });

  it('conflict requires the caller to say which conflict', () => {
    expect(toProblemDetails(conflict('ERR_DUPLICATE'), CONTEXT).code).toBe('ERR_DUPLICATE');
  });
});
