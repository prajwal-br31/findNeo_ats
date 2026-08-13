import { AppError, ValidationError, type FieldError } from './app-error.js';
import { catalogEntry, errorTypeUri, type ErrorCode } from './error-catalog.js';

/**
 * RFC 7807 serialization (07 §6, D-021).
 *
 * This is the last thing between an exception and the client, so it is written
 * to be safe when it is *wrong*: an error it does not recognise becomes a bare
 * `ERR_INTERNAL` with a fixed sentence. It never reads `.message` off an
 * unknown throwable, because that is where SQL text, constraint names, file
 * paths and upstream provider messages live (ER-038, SEC-063).
 *
 * The diagnostic half goes to `describeForLog`, which is logged against the
 * same `traceId` and returned to nobody.
 */

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly instance: string;
  readonly traceId: string;
  readonly fields?: readonly FieldError[];
}

export interface ProblemContext {
  /** The request path — `/v1/jobs`. */
  readonly instance: string;
  /** Correlates this response to the log line carrying the real cause. */
  readonly traceId: string;
}

/** Deliberately says nothing. The cause is in the logs under the traceId. */
const INTERNAL_DETAIL = 'An unexpected error occurred. Quote the traceId when reporting it.';

function problem(
  code: ErrorCode,
  context: ProblemContext,
  extras: { detail?: string; fields?: readonly FieldError[] } = {},
): ProblemDetails {
  const { status, title } = catalogEntry(code);
  return {
    type: errorTypeUri(code),
    title,
    status,
    code,
    ...(extras.detail === undefined ? {} : { detail: extras.detail }),
    instance: context.instance,
    traceId: context.traceId,
    ...(extras.fields === undefined ? {} : { fields: extras.fields }),
  };
}

/**
 * Maps any throwable to the wire shape.
 *
 * Only an `AppError` contributes a `detail` — its author chose that text for a
 * client to read. Everything else is `ERR_INTERNAL`.
 */
export function toProblemDetails(error: unknown, context: ProblemContext): ProblemDetails {
  if (error instanceof ValidationError) {
    const { detail } = error;
    return problem('ERR_VALIDATION_FAILED', context, {
      ...(detail === undefined ? {} : { detail }),
      fields: error.fields,
    });
  }

  if (error instanceof AppError) {
    const { detail } = error;
    return problem(error.code, context, detail === undefined ? {} : { detail });
  }

  return problem('ERR_INTERNAL', context, { detail: INTERNAL_DETAIL });
}

/**
 * The diagnostic view — for the log line, never for a response.
 *
 * Returns a plain object rather than a string so the logger can redact by
 * path (12 §1), and walks `cause` because the useful information is usually
 * two levels down.
 */
export function describeForLog(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      kind: error.name,
      code: error.code,
      status: error.status,
      message: error.message,
      stack: error.stack,
      ...(error.cause === undefined ? {} : { cause: describeForLog(error.cause) }),
    };
  }
  if (error instanceof Error) {
    return {
      kind: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause === undefined ? {} : { cause: describeForLog(error.cause) }),
    };
  }
  return { kind: 'unknown', value: String(error) };
}
