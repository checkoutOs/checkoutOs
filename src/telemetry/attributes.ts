// attributes.ts
// The ONLY source of metric labels (ADR 003 §8.2). Every .add() / .record() /
// .observe() in services, middleware and telemetry takes its attributes from a
// builder here — an inline object literal is a lint error there
// (no-restricted-syntax in eslint.config.js).
//
// Each builder accepts a closed set per key. A metric label is a time series
// per distinct value, so one unbounded value (chkId, orderId, a gateway ID, a
// raw path) creates a series per payment and takes the metrics backend down.
// Those values belong in the log body, never here.
//
// Closed twice:
//   - at compile time — operation, outcome, method and route are unions
//   - at run time — anything outside the set (a cast, a new gateway that was
//     not added here, a route nobody listed) collapses to one fallback value
//     instead of a new series. Telemetry never throws into a payment path.
//
// Imports: @opentelemetry/api and type-only imports. Type imports are erased,
// so this file still loads nothing before instrumentation (see tracing.ts).

import type { Attributes } from '@opentelemetry/api';
import type { GatewayName } from '../types/payment.types';

// ── Closed sets ─────────────────────────────────────────────────────────────

// Mirrors supportedGateways in gateway.registry.ts — not imported, because
// telemetry must not load the registry (it drags in plugins and winston).
// tests/unit/telemetry/attributes.test.ts fails when the two drift.
export const METRIC_GATEWAYS = ['razorpay', 'paytm', 'payu', 'cashfree'] as const;
export type MetricGateway = (typeof METRIC_GATEWAYS)[number];

// The five Promise-returning GatewayPlugin methods (ADR 003 §6.1).
export const GATEWAY_OPERATIONS = [
  'createPayment',
  'getPaymentStatus',
  'createRefund',
  'getRefundStatus',
  'healthCheck',
] as const;
export type GatewayOperation = (typeof GATEWAY_OPERATIONS)[number];

export const GATEWAY_OUTCOMES = ['success', 'timeout', 'gateway_error', 'mapping_error'] as const;
export type GatewayOutcome = (typeof GATEWAY_OUTCOMES)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// Route patterns as Express reports them (baseUrl + route.path). Mirrors the
// routers mounted in app.ts; the attributes test fails when they drift.
export const HTTP_ROUTES = [
  '/payments',
  '/payments/:chkId',
  '/payments/:chkId/refund',
  '/refunds/:refId',
  '/webhooks/:gateway',
  '/health',
  '/checkout/:chkId',
] as const;
export type HttpRoute = (typeof HTTP_ROUTES)[number];

// ── Fallbacks ───────────────────────────────────────────────────────────────

/** A gateway, operation or outcome outside its closed set. */
export const UNKNOWN = 'unknown';
/** Semconv's value for a method outside the known set. */
export const OTHER_METHOD = '_OTHER';
/** No route matched (404 from notFoundHandler), or one not listed above. */
export const UNMATCHED_ROUTE = 'unmatched';

function oneOf<T extends string>(set: readonly T[], value: string): T | typeof UNKNOWN {
  return (set as readonly string[]).includes(value) ? (value as T) : UNKNOWN;
}

// Status codes are bounded by HTTP itself; anything else is a bug upstream.
function statusCode(status: number): number {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

// ── Builders ────────────────────────────────────────────────────────────────

/**
 * Labels for gateway call metrics (`gateway.request.duration`,
 * `gateway.requests`). Gateway is a GatewayName (a string, as plugins report
 * it) and is closed at run time.
 */
export function gatewayLabels(
  gateway: GatewayName,
  operation: GatewayOperation,
  outcome: GatewayOutcome,
): Attributes {
  return {
    gateway: oneOf(METRIC_GATEWAYS, gateway),
    operation: oneOf(GATEWAY_OPERATIONS, operation),
    outcome: oneOf(GATEWAY_OUTCOMES, outcome),
  };
}

/**
 * Labels for webhook metrics (`webhook.signature_failures` and friends).
 * One argument on purpose: the obvious slip, `.add(1, { gateway })`, is the
 * line most likely to be copied (ADR 003 §8.2).
 */
export function webhookLabels(gateway: GatewayName): Attributes {
  return { gateway: oneOf(METRIC_GATEWAYS, gateway) };
}

/**
 * Labels for HTTP metrics, with the stable-semconv keys the instrumentation
 * uses (http.route, http.request.method, http.response.status_code) so
 * custom HTTP metrics join with http.server.request.duration.
 *
 * route is the bounded PATTERN ('/payments/:chkId'), never req.path. Pass
 * undefined when nothing matched.
 */
export function httpLabels(
  method: string,
  route: HttpRoute | undefined,
  status: number,
): Attributes {
  const upper = method.toUpperCase();
  return {
    'http.request.method': (HTTP_METHODS as readonly string[]).includes(upper)
      ? upper
      : OTHER_METHOD,
    'http.route':
      route !== undefined && (HTTP_ROUTES as readonly string[]).includes(route)
        ? route
        : UNMATCHED_ROUTE,
    'http.response.status_code': statusCode(status),
  };
}

/**
 * Labels for the build.info sentinel. version is one value per running
 * process — bounded by deploys, not by traffic.
 */
export function buildInfoLabels(version: string): Attributes {
  return { version };
}
