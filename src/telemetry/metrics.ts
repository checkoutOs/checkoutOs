// metrics.ts
// Every checkoutOs-owned instrument, defined once (ADR 003 §6). The user-facing
// reference — names, labels, allowed values, buckets — is docs/metrics.md;
// keep the two in step. The /metrics shape is pinned by
// observability/exposition.snapshot.txt.
//
// Rules:
//   - NEVER construct a MeterProvider here. NodeSDK (tracing.ts) owns the one
//     global provider; a second one silently empties /metrics.
//   - Instruments are obtained through the global API only.
//   - Names are dotted, without a unit; set `unit` instead. Exporter 0.223.0
//     renders the unit as a `# UNIT` line only (no `_seconds` suffix) and adds
//     `_total` to counters — never write either into a name (ADR 003 §5 2c).
//   - Base units: seconds. Money: minor currency units with a `currency` label.
//   - Attributes ONLY from ./attributes builders (lint-enforced, §8.2).
//
// Instruments are created lazily, on first use: the OTel API has no proxy
// meter, so one obtained before sdk.start() is a permanent no-op. In
// production the SDK is preloaded and has started long before any request.
// Under NODE_ENV=test there is no SDK and every instrument is a no-op.

import { metrics, type Counter, type Histogram, type Meter } from '@opentelemetry/api';
import { buildInfoLabels } from './attributes';
import {
  GATEWAY_REQUEST_BUCKETS,
  WEBHOOK_PROCESSING_BUCKETS,
  WEBHOOK_RELAY_BUCKETS,
} from './buckets';

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
      result.observe(1, buildInfoLabels(version));
    });
}

// ---------------------------------------------------------------------------
// Business instruments
// ---------------------------------------------------------------------------

export interface Instruments {
  // §6.1 gateway calls — recorded by withTelemetry() (gateway.decorator.ts)
  gatewayRequestDuration: Histogram;
  gatewayRequests: Counter;

  // §6.2 payment lifecycle
  paymentsCreated: Counter;
  paymentTransitions: Counter;
  paymentTransitionsBlocked: Counter;
  pollSuccessSuppressed: Counter;

  // §6.3 webhooks
  webhookReceived: Counter;
  webhookSignatureFailures: Counter;
  webhookUnknownPayment: Counter;
  webhookProcessingDuration: Histogram;
  webhookRelayAttempts: Counter;
  webhookRelayDuration: Histogram;

  // §6.4 idempotency and dedup
  idempotencyDecisions: Counter;
  orderIdReservationConflicts: Counter;

  // §6.5 refunds
  refunds: Counter;
  refundAmountMinor: Counter;
}

function createInstruments(meter: Meter): Instruments {
  return {
    gatewayRequestDuration: meter.createHistogram('gateway.request.duration', {
      description: 'Duration of calls to a payment gateway, by operation and outcome.',
      unit: 's',
      advice: { explicitBucketBoundaries: [...GATEWAY_REQUEST_BUCKETS] },
    }),
    gatewayRequests: meter.createCounter('gateway.requests', {
      description: 'Calls to a payment gateway, by operation and outcome.',
    }),

    paymentsCreated: meter.createCounter('payments.created', {
      description: 'Payments created at the gateway and persisted.',
    }),
    paymentTransitions: meter.createCounter('payment.transitions', {
      description: 'Payment status changes, by from/to status and source.',
    }),
    paymentTransitionsBlocked: meter.createCounter('payment.transitions_blocked', {
      description: 'Webhook status changes refused by the payment state machine.',
    }),
    pollSuccessSuppressed: meter.createCounter('gateway.poll_success_suppressed', {
      description: 'Polls that saw SUCCESS but were held back until the webhook arrives.',
    }),

    webhookReceived: meter.createCounter('webhook.received', {
      description: 'Inbound gateway webhooks, by gateway event and processing result.',
    }),
    webhookSignatureFailures: meter.createCounter('webhook.signature_failures', {
      description: 'Inbound webhooks rejected for an invalid signature or checksum.',
    }),
    webhookUnknownPayment: meter.createCounter('webhook.unknown_payment', {
      description: 'Webhooks whose gateway IDs match no checkoutOs payment.',
    }),
    webhookProcessingDuration: meter.createHistogram('webhook.processing.duration', {
      description: 'Webhook state-machine work, excluding the merchant relay.',
      unit: 's',
      advice: { explicitBucketBoundaries: [...WEBHOOK_PROCESSING_BUCKETS] },
    }),
    webhookRelayAttempts: meter.createCounter('webhook.relay.attempts', {
      description: 'Relays of normalised webhook events to WEBHOOK_RELAY_URL, by outcome.',
    }),
    webhookRelayDuration: meter.createHistogram('webhook.relay.duration', {
      description: 'Duration of the relay call to WEBHOOK_RELAY_URL.',
      unit: 's',
      advice: { explicitBucketBoundaries: [...WEBHOOK_RELAY_BUCKETS] },
    }),

    idempotencyDecisions: meter.createCounter('idempotency.decisions', {
      description: 'Idempotency-Key checks on POST /payments, by decision.',
    }),
    orderIdReservationConflicts: meter.createCounter('orderid.reservation_conflicts', {
      description: 'POST /payments whose orderId was already reserved, by resolution.',
    }),

    refunds: meter.createCounter('refunds', {
      description: 'Refund requests, by outcome.',
    }),
    refundAmountMinor: meter.createCounter('refund.amount_minor', {
      description: 'Amount refunded, in minor currency units (paise for INR).',
    }),
  };
}

let instruments: Instruments | undefined;

/** The business instruments. Call at record time, never at module load. */
export function telemetry(): Instruments {
  instruments ??= createInstruments(getMeter());
  return instruments;
}

/** Seconds elapsed since a process.hrtime.bigint() reading. */
export function secondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
