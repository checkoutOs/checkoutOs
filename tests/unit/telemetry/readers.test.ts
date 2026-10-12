// tests/unit/telemetry/readers.test.ts
// Unit tests for the metric reader list (ADR 003 §3.2, §3.4).
//
// Business invariants protected:
//   - Pull is always on; push is strictly opt-in. Nothing leaves the box
//     unless an OTLP endpoint is configured (ADR 003 §2.3)

import { describe, it, expect } from 'vitest';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { buildMetricReaders, createPrometheusReader } from '../../../src/telemetry/readers';
import { loadRuntime } from '../../../src/config/runtime';

describe('buildMetricReaders', () => {
  it('returns only the Prometheus pull reader by default', () => {
    const prometheus = createPrometheusReader();

    const readers = buildMetricReaders(loadRuntime({}), prometheus);

    expect(readers).toEqual([prometheus]);
    expect(readers[0]).toBeInstanceOf(PrometheusExporter);
  });

  it('adds the OTLP push reader when an endpoint is configured', async () => {
    const prometheus = createPrometheusReader();
    const runtime = loadRuntime({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });

    const readers = buildMetricReaders(runtime, prometheus);

    expect(readers).toHaveLength(2);
    expect(readers[0]).toBe(prometheus);
    expect(readers[1]).toBeInstanceOf(PeriodicExportingMetricReader);
    await readers[1]!.shutdown();
  });
});
