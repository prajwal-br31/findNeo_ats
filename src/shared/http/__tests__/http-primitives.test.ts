import { describe, expect, it } from 'vitest';

import { AppError } from '../../errors/app-error.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, paginate, resolveLimit } from '../envelope.js';
import { FIELD_ERROR_CODES, toFieldError, toFieldErrors } from '../field-errors.js';
import { requestHash } from '../idempotency.js';

describe('cursor pagination (07 §5, D-023)', () => {
  it('round-trips', () => {
    const payload = { sortValue: '2026-08-12T09:30:00.000Z', id: '0192f3a1' };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it('is base64url, so it survives a query string unescaped', () => {
    const cursor = encodeCursor({ sortValue: 'a+b/c=d', id: '1' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it.each([
    ['not base64', '!!!!'],
    ['base64 of nonsense', Buffer.from('nonsense').toString('base64url')],
    ['a JSON array', Buffer.from('[]').toString('base64url')],
    ['an object missing members', Buffer.from('{"v":1}').toString('base64url')],
    ['a future version', Buffer.from('{"v":99,"s":"a","i":"b"}').toString('base64url')],
  ])('rejects %s as a validation failure, not a crash', (_label, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(AppError);
    try {
      decodeCursor(cursor);
    } catch (error) {
      expect((error as AppError).code).toBe('ERR_VALIDATION_FAILED');
    }
  });

  it('the error reveals nothing about the encoding (07 §5: opaque)', () => {
    try {
      decodeCursor('!!!!');
    } catch (error) {
      const detail = (error as AppError).detail ?? '';
      for (const leak of ['base64', 'JSON', 'sortValue', 'version']) {
        expect(detail).not.toContain(leak);
      }
    }
  });
});

describe('collection envelope (07 §5)', () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: `id${String(i)}`, at: `t${String(i)}` }));
  const toCursor = (row: { id: string; at: string }): { sortValue: string; id: string } => ({
    sortValue: row.at,
    id: row.id,
  });

  it('drops the probe row and reports hasMore', () => {
    const page = paginate(rows, 3, toCursor);
    expect(page.data).toHaveLength(3);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).toBeDefined();
  });

  it('omits nextCursor on the last page', () => {
    const page = paginate(rows.slice(0, 2), 3, toCursor);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeUndefined();
  });

  it('the cursor points at the last row actually returned', () => {
    const page = paginate(rows, 3, toCursor);
    expect(decodeCursor(page.pagination.nextCursor ?? '')).toEqual({
      sortValue: 't2',
      id: 'id2',
    });
  });
});

describe('collection envelope — limits', () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: `id${String(i)}`, at: `t${String(i)}` }));
  const toCursor = (row: { id: string; at: string }): { sortValue: string; id: string } => ({
    sortValue: row.at,
    id: row.id,
  });

  it('carries data and pagination only — no total count', () => {
    expect(Object.keys(paginate(rows, 3, toCursor))).toEqual(['data', 'pagination']);
  });

  it('handles an empty page', () => {
    const page = paginate([], 3, toCursor);
    expect(page.data).toEqual([]);
    expect(page.pagination.hasMore).toBe(false);
  });

  it.each([
    [undefined, DEFAULT_PAGE_LIMIT],
    [0, 1],
    [-5, 1],
    [10, 10],
    [1000, MAX_PAGE_LIMIT],
    [Number.NaN, DEFAULT_PAGE_LIMIT],
  ])('resolveLimit(%s) is %i', (input, expected) => {
    expect(resolveLimit(input)).toBe(expected);
  });
});

describe('field error mapping (07 §6) is a lookup, not a heuristic', () => {
  it.each([
    ['type', 'ERR_FIELD_TYPE'],
    ['format', 'ERR_FIELD_FORMAT'],
    ['pattern', 'ERR_FIELD_PATTERN'],
    ['minLength', 'ERR_FIELD_TOO_SHORT'],
    ['minItems', 'ERR_FIELD_TOO_SHORT'],
    ['maxLength', 'ERR_FIELD_TOO_LONG'],
    ['maxItems', 'ERR_FIELD_TOO_LONG'],
    ['minimum', 'ERR_FIELD_RANGE'],
    ['maximum', 'ERR_FIELD_RANGE'],
    ['exclusiveMinimum', 'ERR_FIELD_RANGE'],
    ['exclusiveMaximum', 'ERR_FIELD_RANGE'],
    ['enum', 'ERR_FIELD_ENUM'],
    ['const', 'ERR_FIELD_ENUM'],
    ['uniqueItems', 'ERR_FIELD_NOT_UNIQUE'],
    ['additionalProperties', 'ERR_FIELD_UNKNOWN'],
  ])('%s maps to %s', (keyword, code) => {
    expect(toFieldError({ keyword, instancePath: '/title' }).code).toBe(code);
  });

  it('the same failure always produces the same code', () => {
    const error = { keyword: 'minLength', instancePath: '/title', message: 'too short' };
    expect(toFieldError(error)).toEqual(toFieldError(error));
  });
});

describe('field error mapping — paths and fallbacks', () => {
  it('ERR_FIELD_REQUIRED keeps the PARENT path, since the member has none', () => {
    const mapped = toFieldError({
      keyword: 'required',
      instancePath: '/job',
      message: "must have required property 'title'",
      params: { missingProperty: 'title' },
    });
    expect(mapped.code).toBe('ERR_FIELD_REQUIRED');
    expect(mapped.path).toBe('/job');
    expect(mapped.message).toContain('title');
  });

  it('a root-level required error reports / rather than an empty path', () => {
    expect(toFieldError({ keyword: 'required', instancePath: '' }).path).toBe('/');
  });

  it('an unmapped keyword falls back to ERR_FIELD_TYPE and keeps the message', () => {
    const mapped = toFieldError({
      keyword: 'somethingNew',
      instancePath: '/x',
      message: 'must satisfy somethingNew',
    });
    expect(mapped.code).toBe('ERR_FIELD_TYPE');
    expect(mapped.message).toBe('must satisfy somethingNew');
  });

  it('an unmapped keyword is flagged so it surfaces in logs rather than vanishing', () => {
    expect(toFieldError({ keyword: 'somethingNew', instancePath: '/x' }).unmappedKeyword).toBe(
      'somethingNew',
    );
  });

  it('a mapped keyword carries no unmappedKeyword', () => {
    expect(toFieldError({ keyword: 'type', instancePath: '/x' }).unmappedKeyword).toBeUndefined();
  });
});

describe('field error mapping — lists and the closed set', () => {
  it('maps a whole Ajv error list', () => {
    const mapped = toFieldErrors([
      { keyword: 'required', instancePath: '', params: { missingProperty: 'title' } },
      { keyword: 'minimum', instancePath: '/salaryMax' },
    ]);
    expect(mapped.map((f) => f.code)).toEqual(['ERR_FIELD_REQUIRED', 'ERR_FIELD_RANGE']);
  });

  it('the closed set is exactly the twelve codes of 07 §6', () => {
    expect(FIELD_ERROR_CODES).toHaveLength(12);
  });
});

describe('request hashing (07 §9)', () => {
  it('is stable across key order, so a re-serialized retry is not a conflict', () => {
    expect(requestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(requestHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('distinguishes a genuinely different body', () => {
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });

  it('does not confuse an array with an object', () => {
    expect(requestHash([1, 2])).not.toBe(requestHash({ 0: 1, 1: 2 }));
  });

  it('array order matters', () => {
    expect(requestHash([1, 2])).not.toBe(requestHash([2, 1]));
  });

  it('treats an absent body and an explicit null as the same request', () => {
    /* Deliberate, not incidental: they are the same request, and separating
       them would 409 a client that omitted the body on retry having sent
       `null` the first time. */
    expect(requestHash(undefined)).toBe(requestHash(null));
  });
});
