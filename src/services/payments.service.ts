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
  InvalidOrderIdError,
  RefundNotAllowedError,
  RefundAmountExceedsPaymentError,
  OrderIdAmountMismatchError,
  OrderIdCurrencyMismatchError,
  OrderCreationInProgressError,
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
import { ORDER_ID_MAX_LENGTH, ORDER_ID_PATTERN } from '../types/common.types';

import { checkIdempotency, completeIdempotency, releaseIdempotency } from './idempotency.service';
import { findPaymentByOrderId, reserveOrderId } from '../store/payment.store';
import { IdempotencyRequestInProgressError } from '../errors';
import { telemetry } from '../telemetry/metrics';
import {
  orderIdConflictLabels,
  paymentCreatedLabels,
  pollLabels,
  transitionLabels,
} from '../telemetry/attributes';

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

// ---------------------------------------------------------------------------
// validateCreatePaymentRequest
// ---------------------------------------------------------------------------
// Pure request validation — no store or gateway access, so it is safe to run
// before an idempotency key is claimed. createPaymentWithIdempotency() calls
// it up front for exactly that reason; createPayment() calls it too so direct
// callers keep the same contract. Running twice is harmless.
//
// orderId is validated here because it becomes part of a Redis key
// (chk:pay:by-order:{orderId}) and is rendered into the checkout page. An
// unvalidated orderId is not merely untidy: `undefined` collapses every
// malformed request onto the single key chk:pay:by-order:undefined, so one
// caller can be handed another caller's payment.
//
// Not a UUID by design — orderId is the merchant's own reference (invoice
// numbers, sequential ids), and the published API examples use forms like
// `order_abc123`. Requiring UUIDs would force merchants to keep a translation
// table, and would not help concurrency anyway: duplicate orderIds are the
// intended signal for deduplication, so safety comes from atomic reservation
// (reserveOrderId) rather than from forbidding repeats.

function validateCreatePaymentRequest(req: CreatePaymentRequest): void {
  if (typeof req.amount !== 'number' || !Number.isInteger(req.amount) || req.amount <= 0) {
    throw new InvalidAmountError(req.amount);
  }

  if (typeof req.orderId !== 'string' || req.orderId.trim() === '') {
    throw new InvalidOrderIdError(
      req.orderId,
      'orderId is required and must be a non-empty string',
    );
  }

  if (req.orderId.length > ORDER_ID_MAX_LENGTH) {
    throw new InvalidOrderIdError(
      req.orderId,
      `orderId must be at most ${ORDER_ID_MAX_LENGTH} characters`,
    );
  }

  if (!ORDER_ID_PATTERN.test(req.orderId)) {
    throw new InvalidOrderIdError(
      req.orderId,
      'orderId may contain only letters, digits, underscore, hyphen and dot',
    );
  }
}

/*
1) Validate amount + orderId
2) call gateway.createPayment();
3) Use the caller's chk_ID (or generate one)
4) save StorePayment to Redis gatewayPaymentId empty
5) Return PaymentResponse
*/

// chkId is accepted so createPaymentWithIdempotency() can reserve the orderId
// under the same id BEFORE the gateway call. Direct callers may omit it and
// get a freshly generated one, preserving the original contract.
export async function createPayment(
  req: CreatePaymentRequest,
  reservedChkId?: string,
): Promise<PaymentResponse> {
  validateCreatePaymentRequest(req);

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

  log.info('payment.creating', {
    gateway: config.gateway.active,
    orderId: req.orderId,
    amount: req.amount,
  });

  const gatewayResult = await plugin.createPayment(params);

  //   use the reserved chk_ID, or generate one for direct callers
  const chkId = reservedChkId ?? generatePaymentId();
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
  telemetry().paymentsCreated.add(
    1,
    paymentCreatedLabels(stored.gateway, stored.currency, stored.status),
  );
  // create reverse lookup for gatewayOrderId for webhook to find the payment by orderId

  log.info('payment.created', {
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

// Release the claim taken in Step 1, for rejections that happen before the
// gateway is called. No-op when the request carried no idempotency key.
//
// Release is deliberately NOT attempted for failures inside createPayment():
// once plugin.createPayment() has been invoked, an order may exist at the
// gateway even if the call reported an error (a timeout, a dropped connection,
// or a store failure after a successful create). Plugins surface several of
// those as the same PaymentCreationFailedError, so the error type cannot prove
// the gateway was untouched. Holding the claim costs the client one stale
// window; releasing it wrongly costs a duplicate order.
async function releaseClaim(
  idempotency: { key: string; requestHash: string } | undefined,
  reason: string,
): Promise<void> {
  if (!idempotency) {
    return;
  }

  // Never throws — the caller is about to surface the real error.
  const released = await releaseIdempotency({
    key: idempotency.key,
    requestHash: idempotency.requestHash,
  });

  log.debug('idempotency.claim_release_attempted', {
    key: idempotency.key,
    reason,
    released,
  });
}

export async function createPaymentWithIdempotency(
  req: CreatePaymentRequest,
  idempotency?: { key: string; requestHash: string },
): Promise<PaymentResponse> {
  // -----------------------------------------------------------------------
  // Step 0: Validate BEFORE the idempotency key is claimed
  // -----------------------------------------------------------------------
  // checkIdempotency() writes an IN_PROGRESS record as the side effect of a
  // MISS, so anything that throws after it has claimed the key.
  //
  // Validating first keeps a malformed request from ever taking a key. When
  // this ran later (inside createPayment), a rejected request left the key
  // claimed against its bad-payload hash — and the corrected retry carried a
  // different body, so checkIdempotency() saw a hash mismatch and answered
  // IDEMPOTENCY_KEY_REUSED. Because the hash check precedes the staleness
  // check, stale recovery could never clear it: the key stayed unusable for
  // its full 24h TTL and the client had to mint a new one.
  validateCreatePaymentRequest(req);

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
      log.info('idempotency.hit_served', {
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
  // Step 2: Reserve the orderId (catches duplicates even without an idem key)
  // -----------------------------------------------------------------------
  // SET NX on chk:pay:by-order:{orderId}, taken BEFORE the gateway call.
  //
  // The previous read-then-act — findPaymentByOrderId() here, savePayment()
  // after the gateway returned — left a window as wide as a full gateway
  // round-trip (up to the 10s HTTP timeout). Two concurrent requests carrying
  // the same orderId both read "no payment", both created a gateway order, and
  // the second save overwrote the first's index: two live orders for one
  // merchant order, one of them unreachable by orderId.
  //
  // The reservation holds this request's chkId, so if we crash before saving,
  // findPaymentByOrderId() resolves it to null via its two-step lookup (the
  // payment hash does not exist) and the TTL clears it within 30s.
  const chkId = generatePaymentId();
  const reserved = await reserveOrderId(req.orderId, chkId);

  // Both branches below assign `response` and fall through to Step 4 — they
  // never return early. Returning directly from the dedup branch would skip
  // completeIdempotency() and strand the record created by checkIdempotency()
  // as IN_PROGRESS: the caller gets a 201, but the same key replayed inside
  // the 30s stale window gets a 409, and after the window it recovers to MISS
  // and dedups again — so the key could never become a HIT.
  let response: PaymentResponse;

  if (!reserved) {
    // Someone else owns this orderId — either a committed payment (the normal
    // dedup case) or a reservation still in flight.
    const existingByOrderId = await findPaymentByOrderId(req.orderId);

    if (existingByOrderId === null) {
      // Reservation held but no payment yet: a concurrent request is mid-create.
      // Nothing was created at the gateway on this path, so the idempotency
      // claim is provably safe to hand back before surfacing the 409.
      log.warn('orderid.creation_in_progress', { orderId: req.orderId });
      telemetry().orderIdReservationConflicts.add(1, orderIdConflictLabels('in_progress'));
      await releaseClaim(idempotency, 'orderId.creation_in_progress');
      throw new OrderCreationInProgressError(req.orderId);
    }
    // Validate amount matches
    if (existingByOrderId.amount !== req.amount) {
      log.error('orderid.amount_mismatch', {
        orderId: req.orderId,
        existingAmount: existingByOrderId.amount,
        newAmount: req.amount,
      });
      telemetry().orderIdReservationConflicts.add(1, orderIdConflictLabels('amount_mismatch'));
      await releaseClaim(idempotency, 'orderId.amount_mismatch');
      throw new OrderIdAmountMismatchError(req.orderId, existingByOrderId.amount, req.amount);
    }

    // Validate currency matches
    if (existingByOrderId.currency !== req.currency) {
      log.error('orderid.currency_mismatch', {
        orderId: req.orderId,
        existingCurrency: existingByOrderId.currency,
        newCurrency: req.currency,
      });
      telemetry().orderIdReservationConflicts.add(1, orderIdConflictLabels('currency_mismatch'));
      await releaseClaim(idempotency, 'orderId.currency_mismatch');
      throw new OrderIdCurrencyMismatchError(req.orderId, existingByOrderId.currency, req.currency);
    }

    // Same orderId, same amount, same currency — serve the existing payment
    log.debug('orderid.dedup_hit', {
      orderId: req.orderId,
      chkId: existingByOrderId.chkId,
    });
    telemetry().orderIdReservationConflicts.add(1, orderIdConflictLabels('deduplicated'));

    response = {
      paymentId: existingByOrderId.chkId,
      paymentUrl: `${config.app.baseUrl}/checkout/${existingByOrderId.chkId}`,
      status: existingByOrderId.status,
      amount: existingByOrderId.amount,
      currency: existingByOrderId.currency,
      gateway: existingByOrderId.gateway,
      orderId: existingByOrderId.orderId,
      createdAt: existingByOrderId.createdAt,
    };
  } else {
    // ---------------------------------------------------------------------
    // Step 3: Create payment (delegate to existing createPayment)
    // ---------------------------------------------------------------------
    // All validation, gateway call, Redis save, and response building happen
    // inside createPayment(). Keeping it as a separate function preserves the
    // single source of truth for the create flow — tests that exercise
    // createPayment() directly continue to work without modification.
    //
    // chkId is the one already reserved above, so savePayment() commits that
    // reservation rather than writing a second, conflicting index entry.
    //
    // A failure here deliberately leaves BOTH the idempotency claim and the
    // orderId reservation in place: plugin.createPayment() has been invoked, so
    // an order may exist even if the call reported an error. Releasing either
    // one would let a retry create the duplicate this reservation exists to
    // prevent. Both expire on their own within 30s.
    response = await createPayment(req, chkId);
  }

  // -----------------------------------------------------------------------
  // Step 4: Complete idempotency (only if middleware attached a key)
  //
  // Runs for BOTH paths above — a deduped response is cached under this key
  // just like a freshly created one, so replaying the key returns a HIT.
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
    log.debug('payment.status_served_terminal', {
      chkId,
      status: stored.status,
    });
    return toPaymentStatusResponse(stored);
  }

  // Non-terminal: check staleness
  const ageMs = Date.now() - new Date(stored.updatedAt).getTime();

  if (ageMs < REPOLL_STALENESS_MS) {
    log.debug('payment.status_served_fresh', {
      chkId,
      status: stored.status,
      ageMs,
    });
    return toPaymentStatusResponse(stored);
  }

  // Stale non-terminal: re-poll gateway
  log.info('payment.status_repoll', {
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
    log.warn('payment.poll_success_suppressed', {
      chkId,
      currentStatus: stored.status,
      gatewayOrderId: stored.gatewayOrderId,
      hasGatewayPaymentId: stored.gatewayPaymentId !== '',
      reason: 'SUCCESS requires webhook to populate gatewayPaymentId',
    });
    telemetry().pollSuccessSuppressed.add(1, pollLabels(stored.gateway));

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
    log.warn('payment.poll_refund_status_suppressed', {
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
    telemetry().paymentTransitions.add(
      1,
      transitionLabels(stored.gateway, oldStatus, fresh.status, 'poll'),
    );
    stored.status = fresh.status;
    stored.updatedAt = now();

    log.info('payment.status_updated_from_poll', {
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
  log.info('refund.validation_passed', {
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
