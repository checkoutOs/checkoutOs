// metrics.ts
// Rules:
//   - NEVER construct a MeterProvider here. NodeSDK (tracing.ts) owns the one
//     global provider; a second one silently empties /metrics.
//   - Instruments are obtained through the global API only.
//   - Names are dotted with a base unit; the Prometheus exporter adds the

import { metrics, type Meter } from '@opentelemetry/api';

export const METER_NAME = 'checkoutos';

export function getMeter(): Meter {
  return metrics.getMeter(METER_NAME);
}

// Sentinel gauge, rendered as `checkoutos_build_info`. Travels the same path
// as every business instrument — global meter → provider → reader →
// exposition — so its presence in /metrics proves the wiring end to end.
// The boot check in tracing.ts and scripts/verify-telemetry.mjs assert on it.
//
// Do not assert on `target_info` instead: it renders from the reader's own
// resource and appears even when the reader hangs off the wrong provider.
export const BUILD_INFO_METRIC = 'checkoutos_build_info';

export function registerBuildInfo(version: string): void {
  getMeter()
    .createObservableGauge('build.info', {
      description: 'Always 1. Labelled with the running checkoutOs version.',
    })
    .addCallback((result): void => {
      result.observe(1, { version });
    });
}
