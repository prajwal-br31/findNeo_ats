import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics (12 §3), served on the loopback listener and never
 * exposed publicly.
 *
 * **Never labelled by `companyId`.** Tenant count is unbounded, and a label
 * with unbounded cardinality takes the metrics backend down — 12 §3 says so,
 * and `assertNoTenantLabel` turns it from advice into a boot failure.
 * Tenant-specific investigation goes through traces and logs.
 */

/** Labels that would make cardinality unbounded (12 §3). */
const FORBIDDEN_LABELS: ReadonlySet<string> = new Set([
  'companyId',
  'company_id',
  'tenant',
  'tenantId',
  'userId',
  'user_id',
  'email',
]);

export class MetricLabelError extends Error {
  constructor(name: string, label: string) {
    super(
      `metric "${name}" declares label "${label}", which has unbounded cardinality (12 §3). ` +
        'Tenant-specific investigation goes through traces and logs, not metric labels.',
    );
    this.name = 'MetricLabelError';
  }
}

export function assertNoTenantLabel(name: string, labelNames: readonly string[]): void {
  for (const label of labelNames) {
    if (FORBIDDEN_LABELS.has(label)) throw new MetricLabelError(name, label);
  }
}

export interface AppMetrics {
  readonly registry: Registry;
  readonly httpRequests: Counter<'route' | 'method' | 'status'>;
  readonly httpDuration: Histogram<'route' | 'method'>;
}

export function createMetrics(): AppMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequestLabels = ['route', 'method', 'status'] as const;
  assertNoTenantLabel('http_requests_total', httpRequestLabels);
  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by route, method and status',
    labelNames: httpRequestLabels,
    registers: [registry],
  });

  const httpDurationLabels = ['route', 'method'] as const;
  assertNoTenantLabel('http_request_duration_seconds', httpDurationLabels);
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: httpDurationLabels,
    registers: [registry],
  });

  /* The rest of 12 §3 — queue backlog, dead letters, authz resolution,
     outbox_unpublished_age_seconds — arrive with the subsystems that produce
     them. Registering an always-zero gauge would be worse than absent: an
     alert on a metric nothing writes is an alert that never fires. */

  return { registry, httpRequests, httpDuration };
}
