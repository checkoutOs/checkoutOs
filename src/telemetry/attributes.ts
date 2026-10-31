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
import type { Currency, GatewayName, PaymentStatus } from '../types/payment.types';

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

// PaymentStatus values. Template-literal type over an `import type`, so the
// enum itself is never loaded here; the attributes test checks exhaustiveness.
type PaymentStatusValue = `${PaymentStatus}`;
export const PAYMENT_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'CANCELLED',
  'EXPIRED',
] as const satisfies readonly PaymentStatusValue[];

export const CURRENCIES = ['INR'] as const satisfies readonly Currency[];

// Gateway-native webhook event names, as WebhookEvent.event carries them:
// Razorpay's event types and Paytm's TXN STATUS values. Anything else is
// "other". The attributes test checks these against the plugin types.
export const WEBHOOK_EVENTS = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'refund.failed',
  'TXN_SUCCESS',
  'TXN_FAILURE',
  'PENDING',
] as const;
export const OTHER_EVENT = 'other';

// What processWebhook did with one delivery.
export const WEBHOOK_RESULTS = [
  'updated', // gatewayPaymentId backfilled and/or status transitioned
  'unchanged', // duplicate / same-status delivery
  'blocked', // state machine refused the transition
  'unknown_payment', // no chk_ ID for the gateway IDs
  'record_missing', // chk_ ID found, payment hash gone
  'rejected', // parseWebhookEvent threw (bad signature, malformed body)
  'error', // failed after parsing (e.g. Redis)
] as const;
export type WebhookResult = (typeof WEBHOOK_RESULTS)[number];

// Where a payment status change came from.
export const TRANSITION_SOURCES = ['webhook', 'poll', 'refund'] as const;
export type TransitionSource = (typeof TRANSITION_SOURCES)[number];

export const RELAY_OUTCOMES = ['success', 'http_error', 'timeout', 'network_error'] as const;
export type RelayOutcome = (typeof RELAY_OUTCOMES)[number];

// One per checkIdempotency() decision (ADR 003 §6.4).
export const IDEMPOTENCY_RESULTS = [
  'miss',
  'hit',
  'in_progress',
  'stale_recovered',
  'hash_mismatch',
] as const;
export type IdempotencyResult = (typeof IDEMPOTENCY_RESULTS)[number];

// Why reserveOrderId() lost: another payment owns the orderId.
export const ORDERID_CONFLICT_RESULTS = [
  'deduplicated', // same amount + currency — existing payment served
  'in_progress', // concurrent create holds the reservation → 409
  'amount_mismatch',
  'currency_mismatch',
] as const;
export type OrderIdConflictResult = (typeof ORDERID_CONFLICT_RESULTS)[number];

export const REFUND_OUTCOMES = ['created', 'rejected', 'gateway_error'] as const;
export type RefundOutcome = (typeof REFUND_OUTCOMES)[number];

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

/** Labels for `webhook.received`. event is undefined when parsing failed. */
export function webhookReceivedLabels(
  gateway: GatewayName,
  event: string | undefined,
  result: WebhookResult,
): Attributes {
  return {
    gateway: oneOf(METRIC_GATEWAYS, gateway),
    event:
      event !== undefined && (WEBHOOK_EVENTS as readonly string[]).includes(event)
        ? event
        : OTHER_EVENT,
    result: oneOf(WEBHOOK_RESULTS, result),
  };
}

/** Labels for `webhook.relay.attempts`. */
export function relayLabels(outcome: RelayOutcome): Attributes {
  return { outcome: oneOf(RELAY_OUTCOMES, outcome) };
}

/** Labels for `gateway.poll_success_suppressed`. */
export function pollLabels(gateway: GatewayName): Attributes {
  return { gateway: oneOf(METRIC_GATEWAYS, gateway) };
}

/** Labels for `payments.created`. status is a PaymentStatus value. */
export function paymentCreatedLabels(
  gateway: GatewayName,
  currency: string,
  status: string,
): Attributes {
  return {
    gateway: oneOf(METRIC_GATEWAYS, gateway),
    currency: oneOf(CURRENCIES, currency),
    status: oneOf(PAYMENT_STATUSES, status),
  };
}

/**
 * Labels for `payment.transitions` (source = who changed it) and
 * `payment.transitions_blocked` (always source 'webhook' — only webhooks go
 * through the state machine).
 */
export function transitionLabels(
  gateway: GatewayName,
  from: string,
  to: string,
  source: TransitionSource,
): Attributes {
  return {
    gateway: oneOf(METRIC_GATEWAYS, gateway),
    from: oneOf(PAYMENT_STATUSES, from),
    to: oneOf(PAYMENT_STATUSES, to),
    source: oneOf(TRANSITION_SOURCES, source),
  };
}

/** Labels for `idempotency.decisions`. */
export function idempotencyLabels(result: IdempotencyResult): Attributes {
  return { result: oneOf(IDEMPOTENCY_RESULTS, result) };
}

/** Labels for `orderid.reservation_conflicts`. */
export function orderIdConflictLabels(result: OrderIdConflictResult): Attributes {
  return { result: oneOf(ORDERID_CONFLICT_RESULTS, result) };
}

/** Labels for `refunds`. */
export function refundLabels(gateway: GatewayName, outcome: RefundOutcome): Attributes {
  return {
    gateway: oneOf(METRIC_GATEWAYS, gateway),
    outcome: oneOf(REFUND_OUTCOMES, outcome),
  };
}

/** Labels for `refund.amount_minor`. */
export function refundAmountLabels(gateway: GatewayName, currency: string): Attributes {
  return {
    gateway: oneOf(METRIC_GATEWAYS, gateway),
    currency: oneOf(CURRENCIES, currency),
  };
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
