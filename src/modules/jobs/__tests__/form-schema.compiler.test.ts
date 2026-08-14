import { describe, expect, it } from 'vitest';

import {
  compileFields,
  FormCompilationError,
  MAX_FIELDS_PER_VERSION,
  MAX_OPTIONS_PER_SELECT,
  validateFieldDefinitions,
  type FormTemplateField,
} from '../form-schema.compiler.js';

/**
 * T-042 — the schema compiler.
 *
 * A pure function, so this is the one part of Phase 2 that needs no database.
 * Tested per field type because the compiler is what stands between a
 * customer-configured form and an unauthenticated career-site endpoint — a
 * missing constraint here is a denial-of-service vector, not a cosmetic bug.
 */

function field(overrides: Partial<FormTemplateField> & { key: string }): FormTemplateField {
  return {
    dataType: 'text',
    isRequired: false,
    options: [],
    maxLength: null,
    minValue: null,
    maxValue: null,
    ...overrides,
  };
}

describe('T-042: one schema per field type', () => {
  it('compiles text with a bounded maxLength even when none is declared', () => {
    const schema = compileFields([field({ key: 'notes', dataType: 'text' })]);
    /* An unbounded string on a public form is the DoS vector D-028 names. */
    expect(schema.properties['notes']).toEqual({ type: 'string', maxLength: 2000 });
  });

  it('honours a declared maxLength', () => {
    const schema = compileFields([field({ key: 'notes', maxLength: 120 })]);
    expect(schema.properties['notes']).toEqual({ type: 'string', maxLength: 120 });
  });

  it('compiles number with optional bounds', () => {
    const schema = compileFields([
      field({ key: 'years', dataType: 'number', minValue: 0, maxValue: 40 }),
    ]);
    expect(schema.properties['years']).toEqual({ type: 'number', minimum: 0, maximum: 40 });
  });

  it('omits bounds that were not declared', () => {
    const schema = compileFields([field({ key: 'years', dataType: 'number' })]);
    expect(schema.properties['years']).toEqual({ type: 'number' });
  });

  it('compiles date as a format, not a pattern', () => {
    /* `format: 'date'` rejects 2024-02-31; a regex cannot. */
    const schema = compileFields([field({ key: 'start', dataType: 'date' })]);
    expect(schema.properties['start']).toEqual({ type: 'string', format: 'date' });
  });

  it('compiles boolean', () => {
    const schema = compileFields([field({ key: 'remote_ok', dataType: 'boolean' })]);
    expect(schema.properties['remote_ok']).toEqual({ type: 'boolean' });
  });
});

describe('T-042: enum-backed field types', () => {
  it('compiles select as an enum', () => {
    const schema = compileFields([
      field({ key: 'seniority', dataType: 'select', options: ['junior', 'senior'] }),
    ]);
    expect(schema.properties['seniority']).toEqual({
      type: 'string',
      enum: ['junior', 'senior'],
    });
  });

  it('compiles multi_select as a unique array of enum members', () => {
    const schema = compileFields([
      field({ key: 'langs', dataType: 'multi_select', options: ['en', 'de'] }),
    ]);
    expect(schema.properties['langs']).toEqual({
      type: 'array',
      items: { type: 'string', enum: ['en', 'de'] },
      uniqueItems: true,
    });
  });
});

describe('T-042: required and additionalProperties', () => {
  it('lists required fields', () => {
    const schema = compileFields([
      field({ key: 'a', isRequired: true }),
      field({ key: 'b', isRequired: false }),
    ]);
    expect(schema.required).toEqual(['a']);
  });

  it('omits `required` entirely when nothing is required', () => {
    const schema = compileFields([field({ key: 'a' })]);
    expect('required' in schema).toBe(false);
  });

  it('always forbids additional properties', () => {
    /* A client cannot smuggle an undefined key into custom_fields. */
    expect(compileFields([field({ key: 'a' })]).additionalProperties).toBe(false);
    expect(compileFields([]).additionalProperties).toBe(false);
  });

  it('ignores visibility_rule (D-028a, unread in v1)', () => {
    const schema = compileFields([field({ key: 'a', visibilityRule: { show: 'never' } })]);
    expect(schema.properties['a']).toEqual({ type: 'string', maxLength: 2000 });
  });
});

describe('T-042: caps are refused, not clamped', () => {
  it('rejects more than the field cap', () => {
    const many = Array.from({ length: MAX_FIELDS_PER_VERSION + 1 }, (_, index) =>
      field({ key: `f${String(index)}` }),
    );
    expect(() => compileFields(many)).toThrow(FormCompilationError);
  });

  it('rejects more options than the cap', () => {
    const options = Array.from({ length: MAX_OPTIONS_PER_SELECT + 1 }, (_, i) => String(i));
    expect(() => compileFields([field({ key: 'big', dataType: 'select', options })])).toThrow(
      FormCompilationError,
    );
  });

  it('rejects a select with no options', () => {
    /* An empty enum matches nothing, so every submission would fail with a
       message pointing at the value rather than the definition. */
    expect(() => compileFields([field({ key: 'empty', dataType: 'select' })])).toThrow(
      FormCompilationError,
    );
  });

  it('rejects a text field above the length cap', () => {
    expect(() => compileFields([field({ key: 'huge', maxLength: 5000 })])).toThrow(
      FormCompilationError,
    );
  });
});

describe('T-042: key and shape rules', () => {
  it('rejects an invalid field key', () => {
    expect(() => compileFields([field({ key: 'Not Valid' })])).toThrow(FormCompilationError);
  });

  it('rejects duplicate keys', () => {
    expect(() => compileFields([field({ key: 'dup' }), field({ key: 'dup' })])).toThrow(
      FormCompilationError,
    );
  });

  it('rejects a minimum above its maximum', () => {
    expect(() =>
      compileFields([field({ key: 'n', dataType: 'number', minValue: 10, maxValue: 1 })]),
    ).toThrow(FormCompilationError);
  });

  it('reports every problem at once, not just the first', () => {
    /* An editor fixing sixty fields one restart at a time is not usable. */
    const problems = validateFieldDefinitions([
      field({ key: 'Bad Key' }),
      field({ key: 'empty_select', dataType: 'select' }),
    ]);
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});
