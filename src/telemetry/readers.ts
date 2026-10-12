// readers.ts
//
// Builds readers only — never a MeterProvider. tracing.ts hands the list to
// NodeSDK, which owns the single global provider.
//
//   Pull (always on): Prometheus exposition, served by metrics.server.ts.
//                     No queue, no egress — the default (ADR 003 §3.2).
//   Push (opt-in):    OTLP, only when an OTLP endpoint is configured.

import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics';
import type { Runtime } from '../config/runtime';

const OTLP_EXPORT_INTERVAL_MS = 60_000;

// preventServerStart is mandatory. Without it the exporter opens its OWN HTTP
// server on 9464 — EADDRINUSE against metrics.server.ts, and with no auth hook
export function createPrometheusReader(): PrometheusExporter {
  return new PrometheusExporter({ preventServerStart: true, prefix: 'checkoutos' });
}

export function buildMetricReaders(
  runtime: Runtime,
  prometheus: PrometheusExporter,
): MetricReader[] {
  return [
    prometheus,

    // Temporality: Prometheus needs cumulative; Datadog and several OTLP
    // backends want delta. Set OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE
    // =delta for those — the exporter reads it, and temporality is per reader,
    // so the pull path is unaffected.
    ...(runtime.otlpMetricsEnabled
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter(),
            exportIntervalMillis: OTLP_EXPORT_INTERVAL_MS,
          }),
        ]
      : []),
  ];
}
