/**
 * Field definitions → JSON Schema (T-042, 08 §5).
 *
 * A pure function. No database, no cache, no clock — everything it needs is
 * in its argument, which is what makes it exhaustively unit-testable and what
 * makes the caching layer above it trivially correct.
 *
 * The output is validated by the same Ajv instance Fastify uses for static
 * routes, so a custom field and a declared body field fail the same way and
 * produce the same `fields[]` entries.
 */

export type FieldDataType =
  'text' | 'long_text' | 'number' | 'date' | 'boolean' | 'select' | 'multi_select';

export interface FormTemplateField {
  readonly key: string;
  readonly dataType: FieldDataType;
  readonly isRequired: boolean;
  readonly options: readonly string[];
  readonly maxLength: number | null;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  /** Reserved for D-028a. Read by nothing — the compiler ignores it. */
  readonly visibilityRule?: unknown;
}

/** A JSON Schema object, as far as this compiler produces one. */
export interface CompiledSchema {
  readonly type: 'object';
  readonly properties: Record<string, Record<string, unknown>>;
  readonly required?: string[];
  /** Always false. A client cannot smuggle an undefined key into the payload. */
  readonly additionalProperties: false;
}

/** Caps from 06 §5, enforced at publish rather than at render. */
export const MAX_FIELDS_PER_VERSION = 60;
export const MAX_OPTIONS_PER_SELECT = 100;
export const MAX_TEXT_LENGTH = 2_000;
/** Total serialized `custom_fields` payload (BR-048). */
export const MAX_CUSTOM_FIELDS_BYTES = 32 * 1024;

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,48}$/;

export class FormCompilationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`form definition is invalid: ${String(problems.length)} problem(s)`);
    this.name = 'FormCompilationError';
    this.problems = problems;
  }
}

function compileOne(field: FormTemplateField): Record<string, unknown> {
  switch (field.dataType) {
    case 'text':
    case 'long_text':
      /* The cap is applied even when the definition omits one. An unbounded
         string on a form filled through the unauthenticated career site is a
         denial-of-service vector against the customer's own endpoint. */
      return { type: 'string', maxLength: field.maxLength ?? MAX_TEXT_LENGTH };

    case 'number': {
      const schema: Record<string, unknown> = { type: 'number' };
      if (field.minValue !== null) schema['minimum'] = field.minValue;
      if (field.maxValue !== null) schema['maximum'] = field.maxValue;
      return schema;
    }

    case 'date':
      /* `format: 'date'` rather than a regex: Ajv's format keyword rejects
         2024-02-31, which a pattern cannot. */
      return { type: 'string', format: 'date' };

    case 'boolean':
      return { type: 'boolean' };

    case 'select':
      return { type: 'string', enum: [...field.options] };

    case 'multi_select':
      return {
        type: 'array',
        items: { type: 'string', enum: [...field.options] },
        uniqueItems: true,
      };
  }
}

/**
 * Validates a definition against the caps in 06 §5.
 *
 * Separate from compilation and called at publish time, because a definition
 * that violates a cap still compiles into a valid schema — it is the *form*
 * that is unacceptable, not the JSON Schema. Returning every problem at once
 * rather than the first: an editor fixing sixty fields one restart at a time
 * is not a usable product.
 */
function checkOneField(field: FormTemplateField, problems: string[]): void {
  if (!FIELD_KEY_PATTERN.test(field.key)) {
    problems.push(`field key "${field.key}" must match ${String(FIELD_KEY_PATTERN)}`);
  }

  if (field.dataType === 'select' || field.dataType === 'multi_select') {
    if (field.options.length === 0) {
      problems.push(`field "${field.key}" is a ${field.dataType} with no options`);
    }
    if (field.options.length > MAX_OPTIONS_PER_SELECT) {
      problems.push(
        `field "${field.key}" has ${String(field.options.length)} options, the cap is ${String(MAX_OPTIONS_PER_SELECT)}`,
      );
    }
  }

  if (
    (field.dataType === 'text' || field.dataType === 'long_text') &&
    field.maxLength !== null &&
    field.maxLength > MAX_TEXT_LENGTH
  ) {
    problems.push(
      `field "${field.key}" allows ${String(field.maxLength)} characters, the cap is ${String(MAX_TEXT_LENGTH)}`,
    );
  }

  if (
    field.dataType === 'number' &&
    field.minValue !== null &&
    field.maxValue !== null &&
    field.minValue > field.maxValue
  ) {
    problems.push(`field "${field.key}" has a minimum above its maximum`);
  }
}

/**
 * Validates a definition against the caps in 06 5.
 *
 * Separate from compilation and called at publish time, because a definition
 * that violates a cap still compiles into a valid schema - it is the *form*
 * that is unacceptable. Returns every problem at once rather than the first:
 * an editor fixing sixty fields one restart at a time is not a usable product.
 */
export function validateFieldDefinitions(fields: readonly FormTemplateField[]): string[] {
  const problems: string[] = [];

  if (fields.length > MAX_FIELDS_PER_VERSION) {
    problems.push(
      `a version may define at most ${String(MAX_FIELDS_PER_VERSION)} fields, got ${String(fields.length)}`,
    );
  }

  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.key)) problems.push(`duplicate field key "${field.key}"`);
    seen.add(field.key);
    checkOneField(field, problems);
  }

  return problems;
}

/**
 * Compiles fields to a JSON Schema.
 *
 * Throws on a definition that violates the caps, so **compilation must succeed
 * before publish** (08 §4) — an invalid definition can never reach a live form
 * because the publish transaction never commits.
 */
export function compileFields(fields: readonly FormTemplateField[]): CompiledSchema {
  const problems = validateFieldDefinitions(fields);
  if (problems.length > 0) throw new FormCompilationError(problems);

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const field of fields) {
    properties[field.key] = compileOne(field);
    if (field.isRequired) required.push(field.key);
  }

  /* `required` is omitted rather than empty: Ajv treats `required: []` as
     valid but it serialises into every cached schema for no reason. */
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
