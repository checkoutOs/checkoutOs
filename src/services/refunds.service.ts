// refund.service.ts
// Business logic for refund creation and status retrieval.
//
// Orchestrates between:
//   payment.service → validation and gateway preparation
//   GatewayPlugin   → external refund creation and status polling
//   refund.store    → Redis persistence
//   payment.store   → status update after full refund
//
// Rules:
//   - validateAndPrepareRefund in payment.service owns all pre-flight checks
//   - This service owns refund persistence and post-refund payment status updates
//   - Never imports from gateway folder directly — always via getActiveGateway()

import { getActiveGateway } from '../gateways/gateway.registry';
import { saveRefund, findRefundByRefId, updateRefundStatus } from '../store/refund.store';
import { updatePaymentStatus } from '../store/payment.store';
import { validateAndPrepareRefund } from './payments.service';
import { generateRefundId } from '../utils/id';
import { now } from '../utils/time';
import { createContextLogger } from '../utils/logger';
import { config } from '../config';
import { RefundNotFoundError } from '../errors';
import { PaymentStatus, RefundStatus } from '../types/payment.types';
import type {
  CreateRefundRequest,
  RefundResponse,
  RefundStatusResponse,
  StoreRefund,
} from '../types/payment.types';
import type { CreateRefundParams } from '../types/gateway.types';

const log = createContextLogger('refund-service');

// ---------------------------------------------------------------------------
// createRefund
// ---------------------------------------------------------------------------
// Flow:
//   1. Delegate validation to payment.service.validateAndPrepareRefund()
//   2. Call gateway.createRefund() with pay_XXXX (Option C)
//   3. Generate ref_ ID
//   4. Save StoreRefund to Redis
//   5. Update parent payment status if fully refunded
//   6. Return RefundResponse

export async function createRefund(
  chkId: string,
  req: CreateRefundRequest,
): Promise<RefundResponse> {
  // --- Step 1: Validate ---
  // payment.service owns all pre-flight checks:
  //   - payment exists
  //   - status is SUCCESS or PARTIALLY_REFUNDED
  //   - refund amount does not exceed remaining refundable amount
  //   - gatewayPaymentId is set (webhook received)
  const { stored, refundAmount } = await validateAndPrepareRefund(chkId, req);

  const plugin = getActiveGateway();

  // --- Step 2: Call gateway ---
  const params: CreateRefundParams = {
    gatewayPaymentId: stored.gatewayPaymentId, // pay_XXXX — Option C
    amount: refundAmount,
    ...(req.reason !== undefined && { reason: req.reason }),
  };

  log.info('Creating refund', {
    chkId,
    gateway: stored.gateway,
    gatewayPaymentId: stored.gatewayPaymentId,
    amount: refundAmount,
  });

  const gatewayResult = await plugin.createRefund(params);

  // --- Step 3: Generate ref_ ID ---
  const refId = generateRefundId();
  const timestamp = now();

  // --- Step 4: Save to Redis ---
  const storeRefund: StoreRefund = {
    refId,
    chkId,
    gatewayRefundId: gatewayResult.gatewayRefundId,
    gateway: config.gateway.active,
    amount: refundAmount,
    currency: stored.currency,
    status: gatewayResult.status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await saveRefund(storeRefund);

  log.info('Refund created', {
    refId,
    chkId,
    gatewayRefundId: gatewayResult.gatewayRefundId,
    status: gatewayResult.status,
    amount: refundAmount,
  });

  // --- Step 5: Update parent payment status ---
  // If the refund amount equals the full payment amount, the payment is
  // fully refunded. Otherwise it is partially refunded.
  // This is a best-effort update — refund is already persisted above.
  const newPaymentStatus =
    refundAmount === stored.amount ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

  await updatePaymentStatus(chkId, newPaymentStatus);

  log.info('Parent payment status updated after refund', {
    chkId,
    newPaymentStatus,
  });

  // --- Step 6: Return response ---
  return {
    refundId: refId,
    paymentId: chkId,
    status: gatewayResult.status,
    amount: refundAmount,
    currency: stored.currency,
    gateway: config.gateway.active,
    createdAt: timestamp,
  };
}

// ---------------------------------------------------------------------------
// getRefundStatus
// ---------------------------------------------------------------------------
// Reads from Redis first. If the refund is in a non-terminal status,
// re-polls the gateway and updates Redis if the status has changed.
//
// Mirrors the same staleness pattern as getPaymentStatus — terminal statuses
// are immutable and never re-polled.

const TERMINAL_REFUND_STATUSES = new Set<RefundStatus>([RefundStatus.SUCCESS, RefundStatus.FAILED]);

const REPOLL_STALENESS_MS = 10_000;

export async function getRefundStatus(refId: string): Promise<RefundStatusResponse> {
  const stored = await findRefundByRefId(refId);

  if (stored === null) {
    throw new RefundNotFoundError(refId);
  }

  // Terminal status — never re-poll
  if (TERMINAL_REFUND_STATUSES.has(stored.status)) {
    return toRefundStatusResponse(stored);
  }

  // Non-terminal: check staleness
  const ageMs = Date.now() - new Date(stored.updatedAt).getTime();

  if (ageMs < REPOLL_STALENESS_MS) {
    return toRefundStatusResponse(stored);
  }

  // Stale non-terminal: re-poll gateway
  log.info('Refund status stale — re-polling gateway', {
    refId,
    status: stored.status,
    ageMs,
  });

  const plugin = getActiveGateway();
  const fresh = await plugin.getRefundStatus(stored.gatewayRefundId);

  if (fresh.status !== stored.status) {
    await updateRefundStatus(refId, fresh.status);
    stored.status = fresh.status;
    stored.updatedAt = now();

    log.info('Refund status updated from gateway poll', {
      refId,
      newStatus: fresh.status,
    });
  }

  return toRefundStatusResponse(stored);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRefundStatusResponse(stored: StoreRefund): RefundStatusResponse {
  return {
    refundId: stored.refId,
    paymentId: stored.chkId,
    status: stored.status,
    amount: stored.amount,
    currency: stored.currency,
    gateway: stored.gateway,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}
