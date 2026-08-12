/**
 * Parsing and safety guards for PostgreSQL connection URLs.
 *
 * A connection URL carries a password. No function here ever puts the raw URL
 * into an error message, a return value intended for display, or a log line —
 * errors name the database, never the credentials.
 */

const TEST_DATABASE_SUFFIX = '_test';

export interface ParsedDatabaseUrl {
  readonly databaseName: string;
  readonly host: string;
  readonly port: number | null;
}

export class DatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUrlError';
  }
}

/**
 * @throws {DatabaseUrlError} when the value is not a usable postgres URL.
 *   The message never echoes the input.
 */
export function parseDatabaseUrl(raw: string, variableName: string): ParsedDatabaseUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseUrlError(`${variableName}: not a valid URL`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new DatabaseUrlError(`${variableName}: scheme must be postgres:// or postgresql://`);
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (databaseName.length === 0) {
    throw new DatabaseUrlError(`${variableName}: no database name in the URL path`);
  }

  return {
    databaseName,
    host: url.hostname,
    port: url.port === '' ? null : Number.parseInt(url.port, 10),
  };
}

export function isTestDatabaseName(databaseName: string): boolean {
  return databaseName.endsWith(TEST_DATABASE_SUFFIX);
}

/**
 * Refuses any database whose name does not end in `_test`.
 *
 * Called by the config loader for `DATABASE_URL_TEST`, and again by the
 * Testcontainers harness (T-011) against the container-provided URL **before
 * any DDL runs** — the point of the guard is that no schema is ever created,
 * dropped, or truncated in a database that is not demonstrably a test database.
 *
 * @throws {DatabaseUrlError}
 */
export function assertTestDatabaseName(rawUrl: string, context: string): void {
  const { databaseName } = parseDatabaseUrl(rawUrl, context);
  if (!isTestDatabaseName(databaseName)) {
    throw new DatabaseUrlError(
      `${context}: refusing to operate on database "${databaseName}" — ` +
        `a test database name must end in "${TEST_DATABASE_SUFFIX}"`,
    );
  }
}
