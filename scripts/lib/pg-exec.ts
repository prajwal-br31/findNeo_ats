import type { Client } from 'pg';

/**
 * Running statements PostgreSQL builds for us.
 *
 * Identifiers and role passwords cannot be bind parameters, and interpolating
 * them client-side is prohibited (AGENTS.md §3.2), so every dynamic statement
 * goes through `format('%I' / '%L', …)` with the values sent as parameters.
 */

/** Reports which statement failed, rather than only the driver's message. */
export class SetupStepError extends Error {
  constructor(step: string, cause: unknown) {
    super(`${step}\n  ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SetupStepError';
  }
}

/**
 * Fixed-arity builders, one literal string each.
 *
 * `format()` takes `VARIADIC "any"`, so a bare `$2` has no inferable type and
 * PostgreSQL rejects the statement with "could not determine data type of
 * parameter $2". The `::text` casts are what make the bind parameters usable.
 *
 * Written out rather than assembled from a placeholder list: building SQL by
 * interpolation is forbidden (ER-031) even when the interpolated text is only
 * `$2, $3`, and the earlier version of this file that did so was missed by
 * Semgrep rule 1 — see the regex arm added to that rule.
 */
const FORMAT_QUERIES = [
  'SELECT format($1) AS sql',
  'SELECT format($1, $2::text) AS sql',
  'SELECT format($1, $2::text, $3::text) AS sql',
] as const;

/**
 * Has PostgreSQL build the statement and then runs it.
 *
 * Identifiers and role passwords cannot be bind parameters, and interpolating
 * them client-side is prohibited (AGENTS.md §3.2). `format('%I'/'%L', …)` with
 * the values sent as parameters puts all quoting inside the database.
 */
export async function execFormatted(
  client: Client,
  step: string,
  template: string,
  params: readonly string[],
): Promise<void> {
  const builder = FORMAT_QUERIES[params.length];
  if (builder === undefined) {
    throw new SetupStepError(step, `unsupported parameter count ${String(params.length)}`);
  }
  try {
    const built = await client.query<{ sql: string }>(builder, [template, ...params]);
    const sql = built.rows[0]?.sql;
    if (sql === undefined) throw new Error('format() returned no statement');
    await client.query(sql);
  } catch (error) {
    throw new SetupStepError(step, error);
  }
}

/** A statement with no parameters. Literal SQL only. */
export async function exec(client: Client, step: string, sql: string): Promise<void> {
  try {
    await client.query(sql);
  } catch (error) {
    throw new SetupStepError(step, error);
  }
}
