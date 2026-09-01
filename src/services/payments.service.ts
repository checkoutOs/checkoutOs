// payment.service.ts
// logic for payment creation and status retrieval
/* Orchestrates between
    GatewayPlugin -> extrnal payment creatin and status polling
    payment.store -> redis persistence

    Rules:
    Never import from gateway folder directly always via getActiveGateway();
    All gateway errors progagate upward controler map then to http response
    Re-poll strategy non-terminal status+ staleness window (getPaymetnStatus)
*/

import { getActiveGateway } from '../gateways/gateway.registry';
import { savePayment, findPaymentByChkId, updatePaymentStatus } from '../store/payment.store';
import { findRefundsByChkId } from '../store/refund.store';

import { generatePaymentId } from '../utils/id';
import { now } from '../utils/time';
import { createContextLogger } from '../utils/logger';
import { config } from '../config';
import {
  PaymentNotFoundError,
  InvalidAmountError,
  RefundNotAllowedError,
  RefundAmountExceedsPaymentError,
  OrderIdAmountMismatchError,
  OrderIdCurrencyMismatchError,
} from '../errors';
import { PaymentStatus } from '../types/payment.types';
import type {
  CreatePaymentRequest,
  PaymentResponse,
  PaymentStatusResponse,
  CreateRefundRequest,
  StoredPayment,
} from '../types/payment.types';

import type { CreatePaymentParams } from '../types/gateway.types';

import { checkIdempotency, completeIdempotency } from './idempotency.service';
import { findPaymentByOrderId } from '../store/payment.store';
import { IdempotencyRequestInProgressError } from '../errors';

const log = createContextLogger('payment-service');

// rate limit (300 req/min) under load, with a 10s window only one gateway
// call goes out per 10-second period regardless of polling frequency

const REPOLL_STALENESS_MS = 10_000;

const TERMINAL_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.SUCCESS,
  PaymentStatus.FAILED,
  PaymentStatus.REFUNDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.CANCELLED,
  PaymentStatus.EXPIRED,
]);

/*
1) Validate amount
2) call gateway.createPayment();
3) Generate chk_ID
4) save StorePayment to Redis gatewayPaymentId empty 
5) Return PaymentResponse
*/

export async function createPayment(req: CreatePaymentRequest): Promise<PaymentResponse> {
  if (typeof req.amount !== 'number' || !Number.isInteger(req.amount) || req.amount <= 0) {
    throw new InvalidAmountError(req.amount);
  }

  const plugin = getActiveGateway();

  // call gateway
  const params: CreatePaymentParams = {
    orderId: req.orderId,
    amount: req.amount,
    currency: req.currency,
    ...(req.customerName !== undefined && { customerName: req.customerName }),
    ...(req.customerEmail !== undefined && { customerEmail: req.customerEmail }),
    ...(req.customerPhone !== undefined && { customerPhone: req.customerPhone }),
    ...(req.description !== undefined && { description: req.description }),
    ...(req.metadata !== undefined && { metadata: req.metadata }),
  };

  log.info('Creating payment', {
    gateway: config.gateway.active,
    orderId: req.orderId,
    amount: req.amount,
  });

  const gatewayResult = await plugin.createPayment(params);

  //   generate chk_ID
  const chkId = generatePaymentId();
  const timestamp = now();

  /* gatewayPaymentId is empty at creaton time
       It will be populated by webhookService when payment captured arrives
      */
  const stored: StoredPayment = {
    chkId,
    gatewayOrderId: gatewayResult.gatewayOrderId ?? gatewayResult.gatewayId,
    gatewayPaymentId: '',
    gateway: config.gateway.active,
    orderId: req.orderId,
    amount: req.amount,
    currency: req.currency,
    status: gatewayResult.status,
    // Paytm returns a paymentUrl that getCheckoutAction() needs for the 302 redirect.
    // Store it in gatewayMetadata so the core schema stays uniform across all gateways.
    // Razorpay returns no paymentUrl — gatewayMetadata is absent for Razorpay payments.
    ...(gatewayResult.paymentUrl
      ? { gatewayMetadata: { paymentUrl: gatewayResult.paymentUrl } }
      : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await savePayment(stored);
  // create reverse lookup for gatewayOrderId for webhook to find the payment by orderId

  log.info('Payment created', {
    chkId,
    gatewayOrderId: gatewayResult.gatewayId,
    status: gatewayResult.status,
  });
  const paymentUrl = `${config.app.baseUrl}/checkout/${chkId}`;
  return {
    paymentId: chkId,
    paymentUrl,
    status: gatewayResult.status,
    amount: req.amount,
    currency: req.currency,
    gateway: config.gateway.active,
    orderId: req.orderId,
    createdAt: timestamp,
  };
}

// ---------------------------------------------------------------------------
// createPaymentWithIdempotency
// ---------------------------------------------------------------------------
// Main entry point for POST /payments. Wraps createPayment() with two layers
// of duplicate protection:
//
//   1. Idempotency key (header-based, from middleware)
//      - Same key + same body  → returns cached response (no double charge)
//      - Same key + diff body  → 400 IdempotencyKeyReusedError
//      - Parallel reqs same key → one wins, others get 409 IN_PROGRESS
//      - Stale IN_PROGRESS (30s+) auto-recovered
//
//   2. OrderId dedup (payload-based, even without idempotency key)
//      - Same orderId + same amount/currency  → returns existing payment
//      - Same orderId + different amount     → 409 OrderIdAmountMismatchError
//      - Same orderId + different currency   → 409 OrderIdCurrencyMismatchError
//
// After successful creation, completeIdempotency() marks the record COMPLETED.
// That call is NEVER fatal — if it fails, the payment is still returned and
// the record will be auto-recovered on the next retry (30s stale window).
//
// Signature accepts the raw CreatePaymentRequest plus an optional idempotency
// descriptor (key + requestHash) that the middleware attaches to req.idempotency.

export async function createPaymentWithIdempotency(
  req: CreatePaymentRequest,
  idempotency?: { key: string; requestHash: string },
): Promise<PaymentResponse> {
  // -----------------------------------------------------------------------
  // Step 1: Idempotency check (only if middleware attached a key)
  // -----------------------------------------------------------------------
  if (idempotency) {
    const checkResult = await checkIdempotency({
      key: idempotency.key,
      requestHash: idempotency.requestHash,
    });

    // HIT — return cached response from a prior successful request
    if (checkResult.type === 'HIT') {
      log.info('Idempotency HIT — returning cached payment', {
        key: idempotency.key,
      });
      return checkResult.response as PaymentResponse;
    }

    // IN_PROGRESS — another request with this key is currently processing
    if (checkResult.type === 'IN_PROGRESS') {
      throw new IdempotencyRequestInProgressError(idempotency.key);
    }

    // MISS — fall through to create the payment
  }

  // -----------------------------------------------------------------------
  // Step 2: OrderId dedup (catches duplicates even without idempotency key)
  // -----------------------------------------------------------------------
  const existingByOrderId = await findPaymentByOrderId(req.orderId);

  if (existingByOrderId) {
    // Validate amount matches
    if (existingByOrderId.amount !== req.amount) {
      log.error('orderId.amount_mismatch', {
        orderId: req.orderId,
        existingAmount: existingByOrderId.amount,
        newAmount: req.amount,
      });
      throw new OrderIdAmountMismatchError(req.orderId, existingByOrderId.amount, req.amount);
    }

    // Validate currency matches
    if (existingByOrderId.currency !== req.currency) {
      log.error('orderId.currency_mismatch', {
        orderId: req.orderId,
        existingCurrency: existingByOrderId.currency,
        newCurrency: req.currency,
      });
      throw new OrderIdCurrencyMismatchError(req.orderId, existingByOrderId.currency, req.currency);
    }

    // Same orderId, same amount, same currency — return existing payment
    log.debug('orderId.dedup_hit', {
      orderId: req.orderId,
      chkId: existingByOrderId.chkId,
    });

    return {
      paymentId: existingByOrderId.chkId,
      paymentUrl: `${config.app.baseUrl}/checkout/${existingByOrderId.chkId}`,
      status: existingByOrderId.status,
      amount: existingByOrderId.amount,
      currency: existingByOrderId.currency,
      gateway: existingByOrderId.gateway,
      orderId: existingByOrderId.orderId,
      createdAt: existingByOrderId.createdAt,
    };
  }

  // -----------------------------------------------------------------------
  // Step 3: Create payment (delegate to existing createPayment)
  // -----------------------------------------------------------------------
  // All validation, gateway call, Redis save, and response building happen
  // inside createPayment(). Keeping it as a separate function preserves the
  // single source of truth for the create flow — tests that exercise
  // createPayment() directly continue to work without modification.
  const response = await createPayment(req);

  // -----------------------------------------------------------------------
  // Step 4: Complete idempotency (only if middleware attached a key)
  //
  // NEVER fails the response — the payment is already created and persisted.
  // If completeIdempotency() fails, the stale recovery mechanism (30s
  // timeout) will eventually recover the record on the next retry.
  // -----------------------------------------------------------------------
  if (idempotency) {
    const completed = await completeIdempotency({
      key: idempotency.key,
      requestHash: idempotency.requestHash,
      response,
    });

    if (!completed) {
      log.warn('idempotency.complete_non_critical_failure', {
        key: idempotency.key,
        chkId: response.paymentId,
      });
    }
  }

  return response;
}

/*
This keeps gateway cal lrate low under high polling frequency while still providng a self healing pat if a webhook was missed or delayed

*/

export async function getPaymentStatus(chkId: string): Promise<PaymentStatusResponse> {
  // Read from Redis
  const stored = await findPaymentByChkId(chkId);
  if (stored === null) {
    throw new PaymentNotFoundError(chkId);
  }

  // Don't re-poll if terminal status found
  if (TERMINAL_STATUSES.has(stored.status)) {
    log.debug('Payment status terminal - serving from Redis', {
      chkId,
      status: stored.status,
    });
    return toPaymentStatusResponse(stored);
  }

  // Non-terminal: check staleness
  const ageMs = Date.now() - new Date(stored.updatedAt).getTime();

  if (ageMs < REPOLL_STALENESS_MS) {
    log.debug('Payment status fresh - serving from Redis', {
      chkId,
      status: stored.status,
      ageMs,
    });
    return toPaymentStatusResponse(stored);
  }

  // Stale non-terminal: re-poll gateway
  log.info('Payment status stale - re-polling gateway', {
    chkId,
    status: stored.status,
    ageMs,
    gateway: stored.gateway,
    gatewayOrderId: stored.gatewayOrderId,
  });

  const plugin = getActiveGateway();
  const fresh = await plugin.getPaymentStatus(stored.gatewayOrderId);

  //  Never allow polling to transition to SUCCESS
  // SUCCESS must come from webhook to ensure gatewayPaymentId is populated
  if (fresh.status === PaymentStatus.SUCCESS) {
    log.warn('Polling detected SUCCESS status - waiting for webhook backfill', {
      chkId,
      currentStatus: stored.status,
      gatewayOrderId: stored.gatewayOrderId,
      hasGatewayPaymentId: stored.gatewayPaymentId !== '',
      reason: 'SUCCESS requires webhook to populate gatewayPaymentId',
    });

    // Return current Redis state (still PENDING/PROCESSING)
    // The webhook will handle the transition and backfill gatewayPaymentId
    return toPaymentStatusResponse(stored);
  }

  //  Check for gatewayPaymentId before allowing REFUNDED/PARTIALLY_REFUNDED
  // These states also require gatewayPaymentId for refund operations
  const requiresGatewayPaymentId = [
    PaymentStatus.REFUNDED,
    PaymentStatus.PARTIALLY_REFUNDED,
  ].includes(fresh.status);

  if (requiresGatewayPaymentId && stored.gatewayPaymentId === '') {
    log.warn('Polling detected refund status - waiting for webhook backfill', {
      chkId,
      freshStatus: fresh.status,
      currentStatus: stored.status,
      gatewayOrderId: stored.gatewayOrderId,
      reason: 'Refund status requires gatewayPaymentId for further operations',
    });

    // Don't update - let webhook handle it with proper backfill
    return toPaymentStatusResponse(stored);
  }

  //  Only update if status actually changed AND it's safe to do so
  if (fresh.status !== stored.status) {
    const oldStatus = stored.status;
    await updatePaymentStatus(chkId, fresh.status);
    stored.status = fresh.status;
    stored.updatedAt = now();

    log.info('Payment status updated from gateway poll', {
      chkId,
      oldStatus,
      newStatus: fresh.status,
      gatewayPaymentIdPresent: stored.gatewayPaymentId !== '',
    });
  }

  return toPaymentStatusResponse(stored);
}

export async function validateAndPrepareRefund(
  chkId: string,
  req: CreateRefundRequest,
): Promise<{ stored: StoredPayment; refundAmount: number }> {
  /*
    1) Read payment from Redis
    2) Validate payment status is SUCCESS
    3) validate refund amount against original 
    4) Read gatewayPaymentId throw if empty (webhook not yet received)
    5) call gateway.createRefund() single API call with pay_xxx
    6) Return GatewayRefundResult for RefudnServ ice to persist 
    
    RefundService ows persistence (saveRefund) tthis method returns the gateway result so RefundService can attach the chk_ and ref_IDs.
    */
  const stored = await findPaymentByChkId(chkId);
  if (stored === null) {
    throw new PaymentNotFoundError(chkId);
  }

  /*
   validate statsu
   refund only allowed on success payment . 
   PARTIALLY_REFUNDED is also valid — partial refunds can be stacked
   */
  if (
    stored.status !== PaymentStatus.SUCCESS &&
    stored.status !== PaymentStatus.PARTIALLY_REFUNDED
  ) {
    throw new RefundNotAllowedError(chkId, stored.status);
  }
  //   validate refund amount
  const refundAmount = req.amount ?? stored.amount; // full refund is omitted

  if (typeof refundAmount !== 'number' || !Number.isInteger(refundAmount) || refundAmount <= 0) {
    throw new InvalidAmountError(refundAmount);
  }

  // Calculate total already refunded for this payment
  const existingRefunds = await findRefundsByChkId(chkId);
  const alreadyRefunded = existingRefunds.reduce((sum, r): number => sum + r.amount, 0);
  const remainingRefundable = stored.amount - alreadyRefunded;

  if (refundAmount > remainingRefundable) {
    throw new RefundAmountExceedsPaymentError(refundAmount, remainingRefundable);
  }

  //   Validate gatewayPaymentId ---
  // Empty gatewayPaymentId means payment.captured webhook has not arrived yet.
  // The plugin needs pay_XXXX to call POST /payments/:payId/refunds.
  // Attempting a refund before this is set would fail at the gateway anyway —
  // better to fail fast with a clear error here.
  if (stored.gatewayPaymentId === '') {
    throw new RefundNotAllowedError(
      chkId,
      'AWAITING_WEBHOOK — payment.captured webhook has not been received yet',
    );
  }
  log.info('Refund validation passed', {
    chkId,
    refundAmount,
    paymentStatus: stored.status,
    remainingAmount: stored.amount,
  });
  return { stored, refundAmount };
}

function toPaymentStatusResponse(stored: StoredPayment): PaymentStatusResponse {
  return {
    paymentId: stored.chkId,
    status: stored.status,
    amount: stored.amount,
    currency: stored.currency,
    gateway: stored.gateway,
    orderId: stored.orderId,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}
