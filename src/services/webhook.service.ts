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
import type { GatewayName } from '../types/payment.types';
import type { WebhookEvent } from '../types/gateway.types';

const log = createContextLogger('webhook-service');

// Relay timeout — developers server must respond within this window.
// Kept short: checkoutOs should not hold the gateway connection open waiting
// for a slow downstream server.
const RELAY_TIMEOUT_MS = 5_000;

// webhook.service.ts - Fixed processWebhook function

export async function processWebhook(
  gateway: GatewayName,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
): Promise<void> {
  const plugin = getActiveGateway();

  // Parse and verify signature
  const event = plugin.parseWebhookEvent(body, headers);

  log.info('Webhook received', {
    gateway,
    event: event.event,
    gatewayPaymentId: event.gatewayPaymentId,
    status: event.status,
  });

  // ✅ STEP 1: Try to find chkId by gatewayPaymentId
  let chkId = await findChkIdByGatewayId(gateway, event.gatewayPaymentId);

  // ✅ STEP 2: FALLBACK - If not found, try to find by order_id from raw webhook
  if (chkId === null) {
    // Extract order_id from the raw webhook payload
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
        log.info('Found payment via order_id fallback', {
          orderId,
          chkId,
          gatewayPaymentId: event.gatewayPaymentId,
        });
      }
    }
  }

  // If still not found, log warning and return
  if (chkId === null) {
    log.warn('Webhook received for unknown payment', {
      gateway,
      event: event.event,
      gatewayPaymentId: event.gatewayPaymentId,
      reason: 'no_chk_id_found',
    });
    return;
  }

  // Read stored payment
  const stored = await findPaymentByChkId(chkId);

  if (stored === null) {
    log.error('Reverse lookup found chkId but payment record missing', {
      chkId,
      gateway,
      gatewayPaymentId: event.gatewayPaymentId,
    });
    return;
  }

  let paymentUpdated = false;

  // Backfill gatewayPaymentId FIRST
  if (stored.gatewayPaymentId === '' && event.gatewayPaymentId !== '') {
    await updateGatewayPaymentId(chkId, gateway, event.gatewayPaymentId);
    paymentUpdated = true;

    log.info('Gateway payment ID set from webhook', {
      chkId,
      gatewayPaymentId: event.gatewayPaymentId,
      existingStatus: stored.status,
    });
  }

  // Update status if different
  if (event.status !== stored.status) {
    await updatePaymentStatus(chkId, event.status);
    paymentUpdated = true;

    log.info('Payment status updated from webhook', {
      chkId,
      oldStatus: stored.status,
      newStatus: event.status,
      event: event.event,
    });
  }

  if (!paymentUpdated) {
    log.debug('Webhook received but no changes needed', {
      chkId,
      status: stored.status,
      gatewayPaymentId: stored.gatewayPaymentId,
      event: event.event,
    });
  }

  // Relay to developer
  await relayWebhook(chkId, event);
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

  try {
    const response = await axios.post(relayUrl, payload, {
      timeout: RELAY_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    });

    log.info('Webhook relayed successfully', {
      chkId,
      relayUrl,
      statusCode: response.status,
    });
  } catch (err) {
    // Structured warning — contains everything needed to replay manually
    // or to populate a DLQ entry in V1.2.
    const statusCode = axios.isAxiosError(err) ? err.response?.status : undefined;
    const errorMessage = err instanceof Error ? err.message : String(err);

    log.warn('Webhook relay failed', {
      chkId,
      relayUrl,
      statusCode,
      error: errorMessage,
      // event fields for manual replay
      gateway: event.gateway,
      gatewayEvent: event.event,
      gatewayPaymentId: event.gatewayPaymentId,
    });
  }
}
