import { AppError } from '../errors/app-error.js';

/**
 * Cursor pagination (07 §5, D-023).
 *
 * The cursor encodes the sort key and the id of the last row, base64url, and
 * is **opaque** — the encoding may change without notice, so nothing outside
 * this file may parse one. Sorting is always on `(sortField, id)` so the
 * ordering is total and the cursor unambiguous.
 *
 * Never offset: it skips and duplicates rows under concurrent writes, and
 * degrades on deep pages. There is deliberately no total count — an accurate
 * one costs a second scan that dominates query cost on large tenants.
 */

export interface CursorPayload {
  /** The sort field's value on the last row of the previous page. */
  readonly sortValue: string;
  /** Tie-breaker. Makes the ordering total. */
  readonly id: string;
}

/** Bumped if the shape ever changes, so an old cursor is rejected not misread. */
const CURSOR_VERSION = 1;

interface EncodedCursor {
  readonly v: number;
  readonly s: string;
  readonly i: string;
}

export function encodeCursor(payload: CursorPayload): string {
  const encoded: EncodedCursor = { v: CURSOR_VERSION, s: payload.sortValue, i: payload.id };
  return Buffer.from(JSON.stringify(encoded), 'utf8').toString('base64url');
}

/**
 * @throws {AppError} `ERR_VALIDATION_FAILED` — a cursor is client-supplied
 *   input and a malformed one is a validation failure, not a crash. The
 *   message says nothing about the encoding (ER-038): a client that can read
 *   the parse error can construct cursors, and 07 §5 forbids that.
 */
export function decodeCursor(cursor: string): CursorPayload {
  const invalid = (): AppError =>
    new AppError('ERR_VALIDATION_FAILED', {
      detail: 'The cursor is not valid. Use the nextCursor from the previous page.',
    });

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }

  if (typeof parsed !== 'object' || parsed === null) throw invalid();
  const { v, s, i } = parsed as Partial<EncodedCursor>;
  if (v !== CURSOR_VERSION || typeof s !== 'string' || typeof i !== 'string') throw invalid();

  return { sortValue: s, id: i };
}
