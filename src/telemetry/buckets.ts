// buckets.ts
// Explicit histogram bucket boundaries, in SECONDS. See ADR 003 §5 Phase 2d.
//
// Bucket layout is baked into the /metrics exposition, so every dashboard and
// alert downstream inherits it. Changing a boundary is a MAJOR change under
// the metric contract (ADR 003 §7.2) — it silently shifts every quantile.
//
// Rule: every alert threshold must coincide with a boundary.
//
// Applied two ways (ADR 003 §5 Phase 2d):
//   - instruments we create      → `advice: { explicitBucketBoundaries }` in metrics.ts
//   - instruments we do not own  → a View in tracing.ts

// Gateway calls. REQUEST_TIMEOUT_MS is 10 s in both plugins; the 8 s boundary
// exists for the GatewayLatencyP99High alert (p99 > 80% of the timeout).
export const GATEWAY_REQUEST_BUCKETS: readonly number[] = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 8, 10, 15,
];

// Inbound HTTP — emitted by HttpInstrumentation as http.server.request.duration.
export const HTTP_SERVER_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

// Webhook state-machine work, measured BEFORE the relay call. Mostly
// Redis-bound, so sub-millisecond resolution matters.
export const WEBHOOK_PROCESSING_BUCKETS: readonly number[] = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
];

// Merchant relay. RELAY_TIMEOUT_MS is 5 s; boundaries past it capture timeouts.
export const WEBHOOK_RELAY_BUCKETS: readonly number[] = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 7.5,
];
