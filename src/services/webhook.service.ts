// webhook.service.ts
// Processes inbound gateway webhooks and relays them to the developer.
//
// Flow for every inbound webhook:
//   1. Parse + verify signature via GatewayPlugin.parseWebhookEvent()
//   2. Reverse-lookup chk_ ID from gatewayPaymentId
//   3. Update gatewayPaymentId on StoredPayment if not yet set
//   4. Update payment status in Redis
//   5. Relay normalized event to WEBHOOK_RELAY_URL (fire and forget)
//
// Rules:
//   - Internal state (Redis) is always updated before relay is attempted
//   - Relay failure never throws — structured warning log only (V1.2 adds DLQ)
//   - Unknown gateway payment IDs log a warning and return silently
//   - Never returns non-200 to the gateway after signature verification passes

import axios from 'axios';
import { getActiveGateway } from '../gateways/gateway.registry';
import {
  findChkIdByGatewayId,
  findPaymentByChkId,
  updatePaymentStatus,
  updateGatewayPaymentId,
} from '../store/payment.store';
import { createContextLogger } from '../utils/logger';
import { config } from '../config';
import { secondsSince, telemetry } from '../telemetry/metrics';
import {
  relayLabels,
  transitionLabels,
  webhookLabels,
  webhookReceivedLabels,
  type RelayOutcome,
  type WebhookResult,
} from '../telemetry/attributes';
import type { GatewayName } from '../types/payment.types';
import type { WebhookEvent } from '../types/gateway.types';

const log = createContextLogger('webhook-service');

// Relay timeout — developers server must respond within this window.
// Kept short: checkoutOs should not hold the gateway connection open waiting
// for a slow downstream server.
const RELAY_TIMEOUT_MS = 5_000;
/**
Payment gateways may resend old events or deliver webhooks in a different
 * order than they occurred. Without this guard, a payment that has already
 * reached a terminal state (e.g. SUCCESS) could be incorrectly overwritten
 * by a later FAILED, CANCELLED, or PENDING event.
 *
 * Example:
 *   PENDING -> PROCESSING -> SUCCESS   ✅ Allowed
 *   SUCCESS -> FAILED                  ❌ Blocked
 *   FAILED  -> SUCCESS                 ❌ Blocked
 * 
 * Refunds are handled as separate business events and must not modify the
 * original payment lifecycle through normal status transitions.
  */
const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'],
  PROCESSING: ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'],
  SUCCESS: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
  REFUNDED: [],
  PARTIALLY_REFUNDED: [],
};

function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) {
    log.error('webhook.unknown_status', { from, to });
    return false;
  }
  return allowed.includes(to);
}

// processWebhook
//
// Metrics (ADR 003 §6.3): webhook.received {gateway, event, result} for every
// delivery, and webhook.processing.duration around parse + state machine.
// Processing time stops BEFORE the relay: relay latency is the merchant's and
// has its own histogram — nesting it would bury the Redis-bound timings.

export async function processWebhook(
  gateway: GatewayName,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
): Promise<void> {
  const start = process.hrtime.bigint();

  // Parse and verify signature (signature failures are also counted by the
  // gateway decorator, as webhook.signature_failures)
  let event: WebhookEvent;
  try {
    event = getActiveGateway().parseWebhookEvent(body, headers);
  } catch (err) {
    recordWebhook(gateway, undefined, 'rejected', start);
    throw err;
  }

  let applied: AppliedWebhook;
  try {
    applied = await applyWebhook(gateway, body, event);
  } catch (err) {
    recordWebhook(gateway, event.event, 'error', start);
    throw err;
  }
  recordWebhook(gateway, event.event, applied.result, start);

  // Relay to developer — timed separately, in relayWebhook
  if (applied.chkId !== undefined) {
    await relayWebhook(applied.chkId, event);
  }
}

function recordWebhook(
  gateway: GatewayName,
  gatewayEvent: string | undefined,
  result: WebhookResult,
  start: bigint,
): void {
  const m = telemetry();
  m.webhookProcessingDuration.record(secondsSince(start), webhookLabels(gateway));
  m.webhookReceived.add(1, webhookReceivedLabels(gateway, gatewayEvent, result));
}

interface AppliedWebhook {
  result: WebhookResult;
  // Set when the event should be relayed to the merchant.
  chkId?: string;
}

// Reverse lookup + state machine. Everything up to, but not including, the relay.
async function applyWebhook(
  gateway: GatewayName,
  body: unknown,
  event: WebhookEvent,
): Promise<AppliedWebhook> {
  log.info('webhook.received', {
    gateway,
    gatewayEvent: event.event,
    gatewayPaymentId: event.gatewayPaymentId,
    status: event.status,
  });

  // ✅ STEP 1: Try to find chkId by gatewayPaymentId
  let chkId = await findChkIdByGatewayId(gateway, event.gatewayPaymentId);

  // ✅ STEP 2: FALLBACK - If not found, try alternative IDs
  if (chkId === null) {
    // First try: use gatewayOrderId if the plugin provided it (e.g. Paytm's ORDERID).
    // Paytm stores payments with ORDERID as the lookup key at creation time,
    // but webhooks carry TXNID as gatewayPaymentId — so TXNID won't be in Redis
    // until the first webhook is processed. Using ORDERID as a fallback resolves this.
    if (event.gatewayOrderId) {
      chkId = await findChkIdByGatewayId(gateway, event.gatewayOrderId);

      if (chkId) {
        log.info('webhook.lookup_gateway_order_id_fallback', {
          gatewayOrderId: event.gatewayOrderId,
          chkId,
          gatewayPaymentId: event.gatewayPaymentId,
        });
      }
    }

    // Second try: parse raw body for Razorpay-style order_id in JSON webhook
    if (chkId === null) {
      let orderId: string | undefined;

      try {
        const rawBody =
          typeof body === 'string'
            ? body
            : Buffer.isBuffer(body)
              ? body.toString('utf-8')
              : JSON.stringify(body);
        const rawWebhook = JSON.parse(rawBody);
        orderId = rawWebhook?.payload?.payment?.entity?.order_id;
      } catch {
        // Ignore parsing errors
      }

      if (orderId) {
        chkId = await findChkIdByGatewayId(gateway, orderId);

        if (chkId) {
          log.info('webhook.lookup_order_id_fallback', {
            orderId,
            chkId,
            gatewayPaymentId: event.gatewayPaymentId,
          });
        }
      }
    }
  }

  // If still not found, log warning and return
  if (chkId === null) {
    log.warn('webhook.unknown_payment', {
      gateway,
      gatewayEvent: event.event,
      gatewayPaymentId: event.gatewayPaymentId,
      reason: 'no_chk_id_found',
    });
    telemetry().webhookUnknownPayment.add(1, webhookLabels(gateway));
    return { result: 'unknown_payment' };
  }

  // Read stored payment
  const stored = await findPaymentByChkId(chkId);

  if (stored === null) {
    log.error('webhook.payment_record_missing', {
      chkId,
      gateway,
      gatewayPaymentId: event.gatewayPaymentId,
    });
    return { result: 'record_missing' };
  }

  let paymentUpdated = false;
  let blocked = false;

  // Backfill gatewayPaymentId FIRST
  if (stored.gatewayPaymentId === '' && event.gatewayPaymentId !== '') {
    await updateGatewayPaymentId(chkId, gateway, event.gatewayPaymentId);
    paymentUpdated = true;

    log.info('webhook.gateway_payment_id_set', {
      chkId,
      gatewayPaymentId: event.gatewayPaymentId,
      existingStatus: stored.status,
    });
  }

  // Update status if different
  if (event.status !== stored.status) {
    if (!isValidTransition(stored.status, event.status)) {
      log.warn('webhook.transition_blocked', {
        chkId,
        gateway,
        currentStatus: stored.status,
        attemptedStatus: event.status,
        gatewayEvent: event.event,
        gatewayPaymentId: event.gatewayPaymentId,
      });
      telemetry().paymentTransitionsBlocked.add(
        1,
        transitionLabels(gateway, stored.status, event.status, 'webhook'),
      );
      blocked = true;
      // Do NOT throw — return silently to prevent gateway retry storms.
      // Relay should still happen so the developer is aware of the event.
    } else {
      await updatePaymentStatus(chkId, event.status);
      paymentUpdated = true;
      telemetry().paymentTransitions.add(
        1,
        transitionLabels(gateway, stored.status, event.status, 'webhook'),
      );

      log.info('webhook.status_updated', {
        chkId,
        oldStatus: stored.status,
        newStatus: event.status,
        gatewayEvent: event.event,
      });
    }
  }

  if (!paymentUpdated) {
    log.debug('webhook.no_change', {
      chkId,
      status: stored.status,
      gatewayPaymentId: stored.gatewayPaymentId,
      gatewayEvent: event.event,
    });
  }

  return {
    result: blocked ? 'blocked' : paymentUpdated ? 'updated' : 'unchanged',
    chkId,
  };
}

// relayWebhook

async function relayWebhook(chkId: string, event: WebhookEvent): Promise<void> {
  const relayUrl = config.webhook.relayUrl;

  // Normalized payload — what the developer's server receives.
  // Uses chk_ ID (not gateway ID) so developer never sees gateway internals.
  const payload = {
    paymentId: chkId,
    ...event,
  };

  const start = process.hrtime.bigint();
  let outcome: RelayOutcome = 'success';

  try {
    const response = await axios.post(relayUrl, payload, {
      timeout: RELAY_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    });

    log.info('webhook.relay_succeeded', {
      chkId,
      relayUrl,
      statusCode: response.status,
    });
  } catch (err) {
    // Structured warning — contains everything needed to replay manually
    // or to populate a DLQ entry in V1.2.
    const statusCode = axios.isAxiosError(err) ? err.response?.status : undefined;
    const errorMessage = err instanceof Error ? err.message : String(err);
    outcome = classifyRelayError(err);

    log.warn('webhook.relay_failed', {
      chkId,
      relayUrl,
      statusCode,
      error: errorMessage,
      // event fields for manual replay
      gateway: event.gateway,
      gatewayEvent: event.event,
      gatewayPaymentId: event.gatewayPaymentId,
    });
  } finally {
    const m = telemetry();
    m.webhookRelayDuration.record(secondsSince(start));
    m.webhookRelayAttempts.add(1, relayLabels(outcome));
  }
}

// The merchant answered non-2xx → http_error; never answered within
// RELAY_TIMEOUT_MS → timeout; anything else (DNS, refused, reset) → network_error.
function classifyRelayError(err: unknown): RelayOutcome {
  if (axios.isAxiosError(err)) {
    if (err.response !== undefined) return 'http_error';
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 'timeout';
  }
  return 'network_error';
}
