import type { FieldError } from '../errors/app-error.js';

/**
 * Ajv keyword → `fields[].code` (07 §6).
 *
 * A lookup table, not a heuristic: the same validation failure always produces
 * the same code, because clients branch on `code` and nothing else.
 */

export const FIELD_ERROR_CODES = [
  'ERR_FIELD_REQUIRED',
  'ERR_FIELD_TYPE',
  'ERR_FIELD_FORMAT',
  'ERR_FIELD_PATTERN',
  'ERR_FIELD_TOO_SHORT',
  'ERR_FIELD_TOO_LONG',
  'ERR_FIELD_RANGE',
  'ERR_FIELD_ENUM',
  'ERR_FIELD_NOT_UNIQUE',
  'ERR_FIELD_UNKNOWN',
  'ERR_FIELD_IMMUTABLE',
  'ERR_FIELD_CONFLICT',
] as const;

export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

const KEYWORD_TO_CODE: Readonly<Record<string, FieldErrorCode>> = {
  required: 'ERR_FIELD_REQUIRED',
  type: 'ERR_FIELD_TYPE',
  format: 'ERR_FIELD_FORMAT',
  pattern: 'ERR_FIELD_PATTERN',
  minLength: 'ERR_FIELD_TOO_SHORT',
  minItems: 'ERR_FIELD_TOO_SHORT',
  maxLength: 'ERR_FIELD_TOO_LONG',
  maxItems: 'ERR_FIELD_TOO_LONG',
  minimum: 'ERR_FIELD_RANGE',
  maximum: 'ERR_FIELD_RANGE',
  exclusiveMinimum: 'ERR_FIELD_RANGE',
  exclusiveMaximum: 'ERR_FIELD_RANGE',
  enum: 'ERR_FIELD_ENUM',
  const: 'ERR_FIELD_ENUM',
  uniqueItems: 'ERR_FIELD_NOT_UNIQUE',
  additionalProperties: 'ERR_FIELD_UNKNOWN',
};

/**
 * Two codes have no Ajv keyword: they come from checks either side of schema
 * validation. `ERR_FIELD_IMMUTABLE` is the pre-validation rejection of a
 * server-controlled field (SEC-041); `ERR_FIELD_CONFLICT` is a cross-field
 * rule that JSON Schema cannot express, like `salaryMax < salaryMin`.
 */
export const NON_SCHEMA_FIELD_CODES = {
  IMMUTABLE: 'ERR_FIELD_IMMUTABLE',
  CONFLICT: 'ERR_FIELD_CONFLICT',
} as const satisfies Record<string, FieldErrorCode>;

/**
 * An unmapped keyword becomes `ERR_FIELD_TYPE` with the message preserved
 * (07 §6). Silent omission would be worse: the field would validate-fail with
 * no explanation, and the gap would never surface. The caller logs
 * `unmappedKeyword` so it does show up.
 */
export interface MappedFieldError extends FieldError {
  readonly code: FieldErrorCode;
  /** Set when the keyword was not in the table — worth a log line. */
  readonly unmappedKeyword?: string;
}

export interface AjvLikeError {
  readonly keyword: string;
  readonly instancePath: string;
  readonly message?: string | undefined;
  readonly params?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * `path` is a JSON Pointer into the request body.
 *
 * For `required`, Ajv reports the **parent** object's path and names the
 * missing member in `params.missingProperty`. 07 §6 keeps the parent path,
 * because a member that is absent has no path of its own — a client mapping
 * errors onto inputs looks up the parent and reads the name from the message.
 */
export function toFieldError(error: AjvLikeError): MappedFieldError {
  const mapped = KEYWORD_TO_CODE[error.keyword];
  const path = error.instancePath === '' ? '/' : error.instancePath;
  const message = error.message ?? 'is invalid';

  if (mapped === undefined) {
    return { path, code: 'ERR_FIELD_TYPE', message, unmappedKeyword: error.keyword };
  }

  if (mapped === 'ERR_FIELD_REQUIRED') {
    const missing = error.params?.['missingProperty'];
    return {
      path,
      code: mapped,
      message: typeof missing === 'string' ? `${missing} is required.` : message,
    };
  }

  return { path, code: mapped, message };
}

export function toFieldErrors(errors: readonly AjvLikeError[]): MappedFieldError[] {
  return errors.map(toFieldError);
}
