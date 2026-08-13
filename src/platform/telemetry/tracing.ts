import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

import type { Config } from '../config/config.types.js';

/**
 * OpenTelemetry (12 §2).
 *
 * **Off unless configured, and it never egresses by default** (SEC-070). The
 * same instrumentation ships to customers who run this themselves: nothing may
 * phone home, and no vendor account may be required. When enabled it points at
 * a collector the customer controls.
 *
 * Span attributes carry ids only — the same rule as logs (SEC-033). A span
 * attribute is telemetry, and telemetry leaves the building.
 */

export interface TracingHandle {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

const DISABLED: TracingHandle = {
  enabled: false,
  shutdown: () => Promise.resolve(),
};

export function startTracing(config: Config): TracingHandle {
  if (!config.telemetry.enabled) return DISABLED;

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: config.telemetry.otlpEndpoint }),
  });
  sdk.start();

  return {
    enabled: true,
    shutdown: async (): Promise<void> => {
      await sdk.shutdown();
    },
  };
}
