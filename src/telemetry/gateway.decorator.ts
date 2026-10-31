// gateway.decorator.ts
// withTelemetry(plugin) — gateway metrics for every plugin, applied once in
// gateway.registry.ts (ADR 003 §6.1). Plugins themselves never record metrics,
// so a new gateway is instrumented the day it is registered.
//
//   createPayment, getPaymentStatus,      async → gateway.request.duration
//   createRefund, getRefundStatus,                + gateway.requests
//   healthCheck                                   {gateway, operation, outcome}
//   parseWebhookEvent                     SYNC  → webhook.signature_failures
//                                                 {gateway}, on a signature error
//   getCheckoutAction                     passed through (union return, no I/O)
//
// Three details that bite (ADR 003 §6.1):
//   - .bind(plugin) is mandatory: the plugins are classes using this.creds and
//     this.http; an unbound reference throws on the first call.
//   - parseWebhookEvent stays synchronous — wrapping it in async would turn
//     every caller's WebhookEvent into a Promise.
//   - Errors are classified by their `code`, never by class: two gateways can
//     throw different classes for the same meaning.
//
// Imports: telemetry siblings and `import type` only. The error codes below
// are checked against ErrorCodeValue at compile time, without loading
// src/errors (see the telemetry import rule in AGENTS.md).

import type { CheckoutAction, GatewayPlugin, WebhookEvent } from '../types/gateway.types';
import type { StoredPayment } from '../types/payment.types';
import type { ErrorCodeValue } from '../types/common.types';
import {
  gatewayLabels,
  webhookLabels,
  type GatewayOperation,
  type GatewayOutcome,
} from './attributes';
import { secondsSince, telemetry } from './metrics';

/**
 * Error codes that mean "this webhook's signature or checksum is invalid".
 * EVERY NEW GATEWAY must add its code here if it uses its own — it is the one
 * thing the decorator cannot infer (AGENTS.md gateway checklist).
 *
 * Today both plugins throw GatewayInvalidSignatureError; PAYTM_CHECKSUM_FAILED
 * is listed because PaytmChecksumFailedError exists for the same purpose.
 */
export const SIGNATURE_FAILURE_CODES: ReadonlySet<ErrorCodeValue> = new Set<ErrorCodeValue>([
  'GATEWAY_INVALID_SIGNATURE',
  'PAYTM_CHECKSUM_FAILED',
]);

const TIMEOUT_CODE: ErrorCodeValue = 'GATEWAY_TIMEOUT';
const MAPPING_CODE: ErrorCodeValue = 'GATEWAY_MAPPING_ERROR';

// AppError.code, read structurally. Anything without a string code — a raw
// axios error, a TypeError — is a gateway_error.
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code: unknown = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function classifyGatewayError(err: unknown): GatewayOutcome {
  const code = errorCode(err);
  if (code === TIMEOUT_CODE) return 'timeout';
  if (code === MAPPING_CODE) return 'mapping_error';
  return 'gateway_error';
}

export function isSignatureFailure(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && SIGNATURE_FAILURE_CODES.has(code as ErrorCodeValue);
}

export function withTelemetry(plugin: GatewayPlugin): GatewayPlugin {
  const gateway = plugin.name;

  const timed = <A extends unknown[], R>(
    operation: GatewayOperation,
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      const start = process.hrtime.bigint();
      let outcome: GatewayOutcome = 'success';
      try {
        return await fn(...args);
      } catch (err) {
        outcome = classifyGatewayError(err);
        throw err;
      } finally {
        const labels = gatewayLabels(gateway, operation, outcome);
        const m = telemetry();
        m.gatewayRequestDuration.record(secondsSince(start), labels);
        m.gatewayRequests.add(1, labels);
      }
    };
  };

  return {
    name: plugin.name,

    createPayment: timed('createPayment', plugin.createPayment.bind(plugin)),
    getPaymentStatus: timed('getPaymentStatus', plugin.getPaymentStatus.bind(plugin)),
    createRefund: timed('createRefund', plugin.createRefund.bind(plugin)),
    getRefundStatus: timed('getRefundStatus', plugin.getRefundStatus.bind(plugin)),
    healthCheck: timed('healthCheck', plugin.healthCheck.bind(plugin)),

    // SYNC — no await, no histogram. Counter only.
    parseWebhookEvent: (
      body: unknown,
      headers: Record<string, string | string[] | undefined>,
    ): WebhookEvent => {
      try {
        return plugin.parseWebhookEvent(body, headers);
      } catch (err) {
        if (isSignatureFailure(err)) {
          // webhookLabels(), not a literal — the line most likely to be copied.
          telemetry().webhookSignatureFailures.add(1, webhookLabels(gateway));
        }
        throw err;
      }
    },

    // UNION return, no network I/O — passed through untouched.
    getCheckoutAction: (payment: StoredPayment): Promise<CheckoutAction> | CheckoutAction =>
      plugin.getCheckoutAction(payment),
  };
}
