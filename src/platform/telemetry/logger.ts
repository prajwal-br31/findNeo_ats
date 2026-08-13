import { pino, type Logger } from 'pino';

import type { Config } from '../config/config.types.js';

import { redactDeep } from './redaction.js';

/**
 * Structured JSON logging (12 §1). Never `console.log`.
 *
 * Required fields, where applicable: `traceId`, `companyId`, `userId`,
 * `route`, `method`, `statusCode`, `durationMs` for HTTP; `jobName`, `jobId`,
 * `attempt` for the worker.
 *
 * **Production does not log per request at `info`.** 12 §1 is explicit: a
 * per-request line at scale is noise that hides the `error` lines, which are
 * the ones anybody reads.
 */

export type AppLogger = Logger;

export interface LoggerOptions {
  readonly config: Config;
  /** Overridable so a test can capture output without a file descriptor. */
  readonly destination?: NodeJS.WritableStream;
}

export function createLogger(options: LoggerOptions): AppLogger {
  const { config, destination } = options;

  const base = {
    service: 'findneo',
    env: config.nodeEnv,
  };

  const pinoOptions = {
    level: config.logLevel,
    base,
    formatters: {
      level: (label: string) => ({ level: label }),
      /* The backstop for ER-048. Applied to every object logged, at any
         depth — see redaction.ts for why this is not pino's `redact`. */
      log: (object: Record<string, unknown>) => redactDeep(object) as Record<string, unknown>,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return destination === undefined ? pino(pinoOptions) : pino(pinoOptions, destination);
}
