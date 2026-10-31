// tests/helpers/metrics.helper.ts
// In-memory metrics for unit tests.
//
// The OTel SDK never starts under vitest, so instruments are no-ops by
// default. installTestMeterProvider() registers a MeterProvider with a manual
// reader — allowed in tests only; src/ never constructs one. Call it at the
// top of a test file, BEFORE anything records: telemetry() memoises its
// instruments on first use, and the global provider can be set only once per
// file (vitest isolates files).
//
// Values are cumulative, so assert on deltas: delta(name, labels, fn).

import { metrics, type Attributes } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';

class ManualReader extends MetricReader {
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface TestMetrics {
  /** Counter value, or histogram count, summed over series matching `labels`. */
  total(name: string, labels?: Attributes): Promise<number>;
  /** Histogram sum (seconds, for duration histograms) over matching series. */
  sum(name: string, labels?: Attributes): Promise<number>;
  /** How much total(name, labels) moved while fn ran. fn's errors are swallowed. */
  delta(name: string, labels: Attributes, fn: () => unknown): Promise<number>;
}

type PointValue = number | { count: number; sum?: number };

export function installTestMeterProvider(): TestMetrics {
  const reader = new ManualReader();
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

  async function points(name: string, labels: Attributes): Promise<PointValue[]> {
    const { resourceMetrics } = await reader.collect();
    const found: PointValue[] = [];
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (metric.descriptor.name !== name) continue;
        for (const point of metric.dataPoints) {
          const hit = Object.entries(labels).every(
            ([key, value]) => point.attributes[key] === value,
          );
          if (hit) found.push(point.value as PointValue);
        }
      }
    }
    return found;
  }

  const total = async (name: string, labels: Attributes = {}): Promise<number> =>
    (await points(name, labels)).reduce<number>(
      (acc, value) => acc + (typeof value === 'number' ? value : value.count),
      0,
    );

  const sum = async (name: string, labels: Attributes = {}): Promise<number> =>
    (await points(name, labels)).reduce<number>(
      (acc, value) => acc + (typeof value === 'number' ? value : (value.sum ?? 0)),
      0,
    );

  const delta = async (name: string, labels: Attributes, fn: () => unknown): Promise<number> => {
    const before = await total(name, labels);
    try {
      await fn();
    } catch {
      // callers assert on errors separately
    }
    return (await total(name, labels)) - before;
  };

  return { total, sum, delta };
}
