import { Ajv, type ErrorObject } from 'ajv';

import { QUEUE_DOMAINS, type QueueDomain } from '../../shared/ports/queue.js';

import { KNOWN_ENV_KEYS, RawEnvSchema } from './config.schema.js';
import type {
  Config,
  DatabaseConfig,
  LogLevel,
  MailDriver,
  NodeEnv,
  StorageConfig,
  TelemetryConfig,
} from './config.types.js';
import { DatabaseUrlError, isTestDatabaseName, parseDatabaseUrl } from './database-url.js';

/**
 * The single place this process reads its environment (ER-046, SEC-060).
 * Validation is total and happens once, at startup: the process fails fast on
 * a missing or malformed variable rather than discovering it at first use.
 *
 * No error raised here contains a configuration *value* — only variable names
 * and the constraint that was violated. Half of these variables are secrets.
 */

export class ConfigValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Configuration is invalid: ${String(problems.length)} problem(s)`);
    this.name = 'ConfigValidationError';
    this.problems = problems;
  }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0:0:0:0:0:0:0:1',
]);

const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: false });
const validateRawEnv = ajv.compile(RawEnvSchema);

type RawEnv = Record<string, unknown>;

function pickKnownKeys(source: NodeJS.ProcessEnv): RawEnv {
  const picked: RawEnv = {};
  for (const key of KNOWN_ENV_KEYS) {
    const value = source[key];
    // An empty string is an unset variable, not a value of "".
    if (value !== undefined && value !== '') picked[key] = value;
  }
  return picked;
}

function formatAjvErrors(errors: readonly ErrorObject[]): string[] {
  return errors.map((error) => {
    if (error.keyword === 'required') {
      return `${String(error.params['missingProperty'])}: is required and has no default`;
    }
    const key = error.instancePath.replace(/^\//, '');
    // Ajv types `params` as `any`; narrow it rather than trusting it (ER-013).
    const allowed: unknown = error.params['allowedValues'];
    const suffix = Array.isArray(allowed)
      ? ` (allowed: ${(allowed as readonly unknown[]).map((value) => String(value)).join(', ')})`
      : '';
    return `${key || '(root)'}: ${error.message ?? 'is invalid'}${suffix}`;
  });
}

function readString(data: RawEnv, key: string): string {
  const value = data[key];
  if (typeof value !== 'string') throw new Error(`internal: ${key} unvalidated`);
  return value;
}

function readNumber(data: RawEnv, key: string): number {
  const value = data[key];
  if (typeof value !== 'number') throw new Error(`internal: ${key} unvalidated`);
  return value;
}

/** Absent means none. Fail closed: an unset allowlist permits nothing. */
function readOrigins(data: RawEnv): readonly string[] {
  const raw = data['CORS_ALLOWED_ORIGINS'];
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

/**
 * `all` or an explicit comma-separated list. An unknown domain is rejected
 * rather than ignored: a typo that silently drops a domain leaves its jobs
 * queued forever with no process serving them and nothing to see in a log.
 */
function readWorkerDomains(data: RawEnv, problems: string[]): readonly QueueDomain[] {
  const raw = readString(data, 'WORKER_DOMAINS').trim();
  if (raw === 'all') return QUEUE_DOMAINS;

  const requested = raw
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain !== '');

  const unknown = requested.filter(
    (domain) => !(QUEUE_DOMAINS as readonly string[]).includes(domain),
  );
  if (unknown.length > 0) {
    problems.push(
      `WORKER_DOMAINS lists unknown domain(s) ${unknown.join(', ')}. ` +
        `Valid domains are ${QUEUE_DOMAINS.join(', ')}, or \`all\`.`,
    );
  }
  if (requested.length === 0) {
    problems.push('WORKER_DOMAINS is empty. Use `all`, or list at least one domain.');
  }
  return requested.filter((domain): domain is QueueDomain =>
    (QUEUE_DOMAINS as readonly string[]).includes(domain),
  );
}

function readBoolean(data: RawEnv, key: string): boolean {
  return readString(data, key) === 'true';
}

function decodePem(data: RawEnv, key: string, problems: string[]): string {
  const decoded = Buffer.from(readString(data, key), 'base64').toString('utf8');
  if (!decoded.startsWith('-----BEGIN')) {
    problems.push(`${key}: must be a base64-encoded PEM block`);
    return '';
  }
  return decoded;
}

/**
 * The database name must match the mode in both directions: a test run may
 * only touch a `*_test` database, and a non-test process may never touch one.
 */
function databaseNameSuitsMode(
  nodeEnv: NodeEnv,
  databaseName: string,
  problems: string[],
): boolean {
  const looksLikeTest = isTestDatabaseName(databaseName);
  if (nodeEnv === 'test' && !looksLikeTest) {
    problems.push(
      `DATABASE_URL_TEST: refusing database "${databaseName}" — a test database name must end in "_test"`,
    );
    return false;
  }
  if (nodeEnv !== 'test' && looksLikeTest) {
    problems.push(
      `DATABASE_URL: refusing database "${databaseName}" — it looks like a test database and NODE_ENV is "${nodeEnv}"`,
    );
    return false;
  }
  return true;
}

/**
 * Resolves which database this process talks to.
 *
 * In test mode `DATABASE_URL` is never read at all — not preferred-against,
 * not fallen-back-to, but structurally unreachable.
 */
function resolveDatabase(
  nodeEnv: NodeEnv,
  data: RawEnv,
  problems: string[],
): DatabaseConfig | null {
  const isTestMode = nodeEnv === 'test';
  const variableName = isTestMode ? 'DATABASE_URL_TEST' : 'DATABASE_URL';
  const raw = data[variableName];

  if (typeof raw !== 'string') {
    problems.push(
      isTestMode
        ? 'DATABASE_URL_TEST: required when NODE_ENV=test (the Testcontainers harness sets it; ' +
            'set it yourself only to run against a native *_test database). No default exists.'
        : 'DATABASE_URL: required and has no default',
    );
    return null;
  }

  try {
    const parsed = parseDatabaseUrl(raw, variableName);
    if (!databaseNameSuitsMode(nodeEnv, parsed.databaseName, problems)) return null;
    return {
      url: raw,
      databaseName: parsed.databaseName,
      poolMax: readNumber(data, 'DATABASE_POOL_MAX'),
    };
  } catch (error) {
    problems.push(error instanceof DatabaseUrlError ? error.message : `${variableName}: invalid`);
    return null;
  }
}

function resolveStorage(data: RawEnv, problems: string[]): StorageConfig | null {
  const driver = readString(data, 'STORAGE_DRIVER');
  if (driver === 's3') return { driver: 's3' };

  const root = data['STORAGE_FS_ROOT'];
  if (typeof root !== 'string') {
    problems.push('STORAGE_FS_ROOT: required when STORAGE_DRIVER=filesystem');
    return null;
  }
  return { driver: 'filesystem', root };
}

function resolveTelemetry(data: RawEnv, problems: string[]): TelemetryConfig | null {
  if (!readBoolean(data, 'OTEL_ENABLED')) return { enabled: false };

  const endpoint = data['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (typeof endpoint !== 'string') {
    problems.push('OTEL_EXPORTER_OTLP_ENDPOINT: required when OTEL_ENABLED=true');
    return null;
  }
  return { enabled: true, otlpEndpoint: endpoint };
}

function checkOpsListener(data: RawEnv, problems: string[]): void {
  const host = readString(data, 'OPS_HOST');
  if (!LOOPBACK_HOSTS.has(host)) {
    problems.push(
      `OPS_HOST: must be a loopback address — /health/* and /metrics run on a ` +
        `separate listener that is never publicly reachable (SEC-021, 12 §3)`,
    );
  }
  if (readNumber(data, 'OPS_PORT') === readNumber(data, 'API_PORT')) {
    problems.push('OPS_PORT: must differ from API_PORT — they are two distinct listeners');
  }
}

function checkSwagger(nodeEnv: NodeEnv, data: RawEnv, problems: string[]): void {
  if (nodeEnv === 'production' && readBoolean(data, 'SWAGGER_ENABLED')) {
    problems.push('SWAGGER_ENABLED: must be false when NODE_ENV=production (07 §7, 12 §10)');
  }
}

/**
 * @throws {ConfigValidationError} listing every problem found, not just the first.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const data = pickKnownKeys(source);

  if (!validateRawEnv(data)) {
    throw new ConfigValidationError(formatAjvErrors(validateRawEnv.errors ?? []));
  }

  const problems: string[] = [];
  const nodeEnv = readString(data, 'NODE_ENV') as NodeEnv;

  const database = resolveDatabase(nodeEnv, data, problems);
  const storage = resolveStorage(data, problems);
  const telemetry = resolveTelemetry(data, problems);
  const workerDomains = readWorkerDomains(data, problems);
  const jwtPrivateKeyPem = decodePem(data, 'JWT_PRIVATE_KEY', problems);
  const jwtPublicKeyPem = decodePem(data, 'JWT_PUBLIC_KEY', problems);
  checkOpsListener(data, problems);
  checkSwagger(nodeEnv, data, problems);

  if (database === null || storage === null || telemetry === null || problems.length > 0) {
    throw new ConfigValidationError(problems);
  }

  return {
    nodeEnv,
    logLevel: readString(data, 'LOG_LEVEL') as LogLevel,
    api: { host: readString(data, 'API_HOST'), port: readNumber(data, 'API_PORT') },
    ops: { host: readString(data, 'OPS_HOST'), port: readNumber(data, 'OPS_PORT') },
    database,
    storage,
    mail: { driver: readString(data, 'MAIL_DRIVER') as MailDriver },
    corsAllowedOrigins: readOrigins(data),
    auth: {
      jwtPrivateKeyPem,
      jwtPublicKeyPem,
      cookieSecret: readString(data, 'COOKIE_SECRET'),
      secretEncryptionKey: readString(data, 'SECRET_ENCRYPTION_KEY'),
    },
    workerDomains,
    swagger: { enabled: readBoolean(data, 'SWAGGER_ENABLED') },
    telemetry,
  };
}

/**
 * A redacted view for startup logs and the `config:check` command.
 * Secrets are reported as present or absent; their values never appear.
 */
export function describeConfig(config: Config): Record<string, string> {
  return {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    apiListener: `${config.api.host}:${String(config.api.port)}`,
    opsListener: `${config.ops.host}:${String(config.ops.port)} (loopback)`,
    databaseName: config.database.databaseName,
    databaseUrl: '[redacted]',
    databasePoolMax: String(config.database.poolMax),
    storage: config.storage.driver === 'filesystem' ? `filesystem @ ${config.storage.root}` : 's3',
    mailDriver: config.mail.driver,
    corsAllowedOrigins:
      config.corsAllowedOrigins.length === 0
        ? '(none — no cross-origin permitted)'
        : config.corsAllowedOrigins.join(', '),
    jwtKeypair: '[set]',
    cookieSecret: '[set]',
    secretEncryptionKey: '[set]',
    workerDomains: config.workerDomains.join(', '),
    swaggerEnabled: String(config.swagger.enabled),
    telemetry: config.telemetry.enabled ? config.telemetry.otlpEndpoint : 'disabled',
  };
}
