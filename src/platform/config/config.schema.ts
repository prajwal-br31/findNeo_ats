import { Type, type TSchema } from '@sinclair/typebox';

/**
 * A closed set of string values, emitted as JSON Schema `enum` rather than
 * `anyOf: [const, const, …]`. Ajv reports the former as one error naming every
 * allowed value; the latter produces one error per branch plus an `anyOf`
 * error, which turns a single typo into six lines of noise at startup.
 */
function StringEnum(values: readonly string[]): TSchema {
  return Type.Unsafe<string>({ type: 'string', enum: [...values] });
}

/**
 * Per-variable shape of the raw environment. Cross-field rules that depend on
 * `NODE_ENV` (required database URLs, production Swagger, loopback ops bind)
 * are not expressible here and live in `config.ts`.
 *
 * Booleans are modelled as the literal strings `'true'` / `'false'` rather than
 * relying on Ajv coercion: coercion silently accepts `'1'`, `''`, and `'0'`,
 * and a config flag that is wrong in a surprising direction is exactly the
 * class of mistake SEC-060 exists to prevent.
 */
const BooleanString = StringEnum(['true', 'false']);

const PortNumber = Type.Integer({ minimum: 1, maximum: 65535 });

export const RawEnvSchema = Type.Object(
  {
    NODE_ENV: StringEnum(['development', 'test', 'staging', 'production']),
    LOG_LEVEL: StringEnum(['fatal', 'error', 'warn', 'info', 'debug']),

    API_HOST: Type.String({ minLength: 1 }),
    API_PORT: PortNumber,

    OPS_HOST: Type.String({ minLength: 1 }),
    OPS_PORT: PortNumber,

    /* Optional here, required conditionally in config.ts — which one is
       mandatory depends on NODE_ENV, and neither has a default. */
    DATABASE_URL: Type.Optional(Type.String({ minLength: 1 })),
    DATABASE_URL_TEST: Type.Optional(Type.String({ minLength: 1 })),
    DATABASE_POOL_MAX: Type.Integer({ minimum: 1, maximum: 100 }),

    STORAGE_DRIVER: StringEnum(['filesystem', 's3']),
    STORAGE_FS_ROOT: Type.Optional(Type.String({ minLength: 1 })),

    MAIL_DRIVER: StringEnum(['log', 'smtp']),

    /* Comma-separated origins permitted on credentialed routes. Optional, and
       absent means NONE — the closed default. CORS is never `*` on a
       credentialed route (SEC-061), and the career-page origin that the public
       surface needs is not known until Phase 4 (D-043). */
    CORS_ALLOWED_ORIGINS: Type.Optional(Type.String({ minLength: 1 })),

    /* Base64-encoded PEM. Multi-line values do not survive `.env` transport
       reliably, so the key material is base64 on the wire and decoded here. */
    JWT_PRIVATE_KEY: Type.String({ minLength: 1 }),
    JWT_PUBLIC_KEY: Type.String({ minLength: 1 }),
    COOKIE_SECRET: Type.String({ minLength: 32 }),

    SWAGGER_ENABLED: BooleanString,
    OTEL_ENABLED: BooleanString,
    OTEL_EXPORTER_OTLP_ENDPOINT: Type.Optional(Type.String({ minLength: 1 })),
  },
  {
    /* `additionalProperties: false` is deliberately NOT set. ER-036 governs
       API request bodies; the process environment legitimately carries
       hundreds of unrelated variables. Only the keys below are ever read. */
    additionalProperties: true,
  },
);

/** The complete set of environment variables this process reads. */
export const KNOWN_ENV_KEYS: readonly string[] = Object.keys(RawEnvSchema.properties);
