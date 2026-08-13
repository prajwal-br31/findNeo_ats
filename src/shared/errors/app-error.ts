import { catalogEntry, type ErrorCode } from './error-catalog.js';

/**
 * The application error hierarchy (ER-037).
 *
 * Subclassed only where a category carries genuine extra structure —
 * validation carries `fields[]`, a business-rule violation carries its
 * `BR-nnn`. Everything else is the base class plus a code, because twenty
 * near-identical subclasses is ceremony that teaches a reader nothing (D-038's
 * reasoning, applied to errors).
 *
 * **`detail` reaches the client.** Never put a database message, a constraint
 * name, a file path, or an upstream provider's text in it (ER-038, SEC-063).
 * Anything diagnostic belongs on `cause`, which is logged and never
 * serialized.
 */

export interface FieldError {
  /** JSON Pointer into the request body — `/title`, `/salaryMax`. */
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface AppErrorOptions {
  /** Client-facing. Must contain nothing internal. */
  readonly detail?: string;
  /** Diagnostic only. Logged against the traceId, never serialized. */
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const { title } = catalogEntry(code);
    super(options.detail ?? title, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = catalogEntry(code).status;
  }

  /** Client-safe explanation, or undefined to let the catalog title stand. */
  get detail(): string | undefined {
    return this.message === catalogEntry(this.code).title ? undefined : this.message;
  }
}

/** Schema validation failed. Carries the per-field detail a form needs. */
export class ValidationError extends AppError {
  readonly fields: readonly FieldError[];

  constructor(fields: readonly FieldError[], options: AppErrorOptions = {}) {
    super('ERR_VALIDATION_FAILED', {
      detail: options.detail ?? 'One or more fields are invalid.',
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

/**
 * A named business rule was violated. `detail` cites the rule id, because
 * 07 §6 requires it and because "which rule?" is the first question asked.
 */
export class BusinessRuleError extends AppError {
  readonly ruleId: string;

  constructor(ruleId: string, detail: string, options: AppErrorOptions = {}) {
    super('ERR_BUSINESS_RULE_VIOLATION', {
      detail: `${ruleId}: ${detail}`,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'BusinessRuleError';
    this.ruleId = ruleId;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Another tenant's resource is indistinguishable from one that never existed
 * (ER-021, SEC-007). A 403 would confirm it exists and enable enumeration.
 * There is deliberately no `notAnotherTenant()` variant — one function, so the
 * two cases cannot diverge.
 */
export function notFound(detail?: string): AppError {
  return new AppError('ERR_NOT_FOUND', detail === undefined ? {} : { detail });
}

export function forbidden(detail?: string): AppError {
  return new AppError('ERR_FORBIDDEN', detail === undefined ? {} : { detail });
}

export function unauthenticated(detail?: string): AppError {
  return new AppError('ERR_UNAUTHENTICATED', detail === undefined ? {} : { detail });
}

/** The four 409s, named so a caller must pick which conflict this is. */
export type ConflictCode =
  'ERR_CONFLICT' | 'ERR_INVALID_TRANSITION' | 'ERR_DUPLICATE' | 'ERR_IDEMPOTENCY_CONFLICT';

export function conflict(code: ConflictCode, detail?: string): AppError {
  return new AppError(code, detail === undefined ? {} : { detail });
}

/** Wraps an unexpected failure. The cause is logged; the client sees nothing. */
export function internal(cause?: unknown): AppError {
  return new AppError('ERR_INTERNAL', cause === undefined ? {} : { cause });
}
