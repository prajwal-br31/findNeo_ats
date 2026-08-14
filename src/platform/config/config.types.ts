import type { QueueDomain } from '../../shared/ports/queue.js';

/**
 * Typed shape of validated application configuration.
 *
 * Nothing in this codebase reads `process.env` outside `config.ts` (ER-046).
 * Consumers receive this object; they never reach for the environment.
 */

export type NodeEnv = 'development' | 'test' | 'staging' | 'production';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

export type MailDriver = 'log' | 'smtp';

export type StorageDriver = 'filesystem' | 's3';

export interface ListenerConfig {
  readonly host: string;
  readonly port: number;
}

export interface DatabaseConfig {
  /** Full connection URL. Contains a password — never log this field. */
  readonly url: string;
  /** Database name parsed out of the URL. Safe to log. */
  readonly databaseName: string;
  readonly poolMax: number;
}

/**
 * Discriminated so a consumer cannot read `root` without first narrowing to
 * the filesystem driver. Phase 0 ships `filesystem` only (D-004); the S3
 * adapter arrives in Phase 3 and must pass the same conformance suite.
 */
export type StorageConfig =
  { readonly driver: 'filesystem'; readonly root: string } | { readonly driver: 's3' };

/**
 * The smtp branch carries its settings, so a `driver: 'smtp'` config that is
 * missing a host is not representable. The adapter cannot be constructed
 * without them, which is what makes "fails to start" a type-level guarantee
 * rather than a runtime check somebody remembers to write.
 */
export type MailConfig =
  | { readonly driver: 'log' }
  | {
      readonly driver: 'smtp';
      readonly host: string;
      readonly port: number;
      readonly user: string;
      /** Secret. Never log, never serialize, never include in an error. */
      readonly password: string;
      readonly from: string;
    };

/** Disabled by default — telemetry never egresses by default (SEC-070). */
export type TelemetryConfig =
  { readonly enabled: false } | { readonly enabled: true; readonly otlpEndpoint: string };

/** Secrets. Never log, never serialize, never include in an error message. */
export interface AuthSecretsConfig {
  readonly jwtPrivateKeyPem: string;
  readonly jwtPublicKeyPem: string;
  readonly cookieSecret: string;
  /** base64, 32 bytes. Encrypts secrets at rest. */
  readonly secretEncryptionKey: string;
}

export interface Config {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  /** Public listener: `/v1/*` and `/bff/web/*`. */
  readonly api: ListenerConfig;
  /** Operational listener: `/health/*` and `/metrics`, loopback only (SEC-021). */
  readonly ops: ListenerConfig;
  readonly database: DatabaseConfig;
  readonly storage: StorageConfig;
  readonly mail: MailConfig;
  /** Empty means no cross-origin request is permitted. Never `*`. */
  readonly corsAllowedOrigins: readonly string[];
  readonly auth: AuthSecretsConfig;
  /** Queue domains this process serves. Never empty — validated at load. */
  readonly workerDomains: readonly QueueDomain[];
  readonly swagger: { readonly enabled: boolean };
  readonly telemetry: TelemetryConfig;
}
