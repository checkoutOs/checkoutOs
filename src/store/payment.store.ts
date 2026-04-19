// payment.store.ts
// All Redis operations for payment records and gateway ID mapping.
//
// Key patterns:
//   chk:pay:{chk_id}              → Hash   — full StoredPayment record
//   chk:gw:{gateway}:{gw_id}      → String — reverse lookup: gw_id → chk_id
//
// Option C — two gateway ID fields:
//
//   gatewayOrderId   is written to Redis at savePayment() (creation time).
//   gatewayPaymentId is written to Redis at updateGatewayPaymentId() (after webhook).
//
//   The reverse lookup key is set for gatewayOrderId at creation AND for
//   gatewayPaymentId when it arrives via webhook. Both point to the same chk_id.
//   This allows WebhookService to correlate either ID back to a chk_ record.
//
// Rules:
//   - Every ioredis error is caught and re-thrown as StoreError
//   - Redis field names match StoredPayment keys exactly
//   - Services and controllers never import from redis.client directly

import { redisClient } from './redis.client';
import { StoreError } from '../errors/store.errors';
import { now } from '../utils/time';
import type { StoredPayment } from '../types/payment.types';
import { PaymentStatus } from '../types/payment.types';

// ---------------------------------------------------------------------------
// Key builders

const Keys = {
  payment: (chkId: string): string => `chk:pay:${chkId}`,

  // Reverse lookup — maps any gateway-native ID back to a chk_ ID.
  // Used twice per payment lifecycle:
  //   1. At creation with gatewayOrderId (order_XXXX)
  //   2. After webhook with gatewayPaymentId (pay_XXXX)
  gatewayLookup: (gateway: string, gwId: string): string => `chk:gw:${gateway}:${gwId}`,
};

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------
// Redis Hashes store every value as a string.
// These helpers convert StoredPayment ↔ flat string record.

function serialisePayment(payment: StoredPayment): Record<string, string> {
  return {
    chkId: payment.chkId,
    gatewayOrderId: payment.gatewayOrderId,
    gatewayPaymentId: payment.gatewayPaymentId,
    gateway: payment.gateway,
    orderId: payment.orderId,
    amount: String(payment.amount),
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

function deserialisePayment(raw: Record<string, string>): StoredPayment {
  return {
    chkId: raw['chkId'] ?? '',
    gatewayOrderId: raw['gatewayOrderId'] ?? '',
    gatewayPaymentId: raw['gatewayPaymentId'] ?? '',
    gateway: raw['gateway'] as StoredPayment['gateway'],
    orderId: raw['orderId'] ?? '',
    amount: parseInt(raw['amount'] ?? '0', 10),
    currency: raw['currency'] as StoredPayment['currency'],
    status: raw['status'] as PaymentStatus,
    createdAt: raw['createdAt'] ?? '',
    updatedAt: raw['updatedAt'] ?? '',
  };
}

// ---------------------------------------------------------------------------
// savePayment
// ---------------------------------------------------------------------------
// Called by PaymentService after createPayment() returns.
//
// At this point:
//   gatewayOrderId   = order_XXXX (known)
//   gatewayPaymentId = ''         (not yet assigned by Razorpay)
//
// Sets the reverse lookup for gatewayOrderId only.
// The pay_XXXX lookup is set later by updateGatewayPaymentId().

export async function savePayment(payment: StoredPayment): Promise<void> {
  try {
    const pipeline = redisClient.pipeline();

    // Write the full payment hash
    pipeline.hset(Keys.payment(payment.chkId), serialisePayment(payment));

    // Reverse lookup for gatewayOrderId → chk_id.
    // Allows status polling via order_XXXX before webhook arrives.
    pipeline.set(Keys.gatewayLookup(payment.gateway, payment.gatewayOrderId), payment.chkId);

    await pipeline.exec();
  } catch (err) {
    throw new StoreError(`savePayment:${payment.chkId}`, err);
  }
}

// ---------------------------------------------------------------------------
// findPaymentByChkId
// ---------------------------------------------------------------------------

export async function findPaymentByChkId(chkId: string): Promise<StoredPayment | null> {
  try {
    const raw = await redisClient.hgetall(Keys.payment(chkId));

    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }

    return deserialisePayment(raw);
  } catch (err) {
    // Bug fix: err was previously inside the template string, not passed as argument
    throw new StoreError(`findPaymentByChkId:${chkId}`, err);
  }
}

// ---------------------------------------------------------------------------
// findChkIdByGatewayId
// ---------------------------------------------------------------------------
// Reverse lookup — used by WebhookService to correlate an inbound gateway ID
// (either order_XXXX or pay_XXXX) back to the internal chk_ ID.

export async function findChkIdByGatewayId(
  gateway: string,
  gatewayId: string,
): Promise<string | null> {
  try {
    const chkId = await redisClient.get(Keys.gatewayLookup(gateway, gatewayId));
    return chkId;
  } catch (err) {
    throw new StoreError(`findChkIdByGatewayId:${gateway}:${gatewayId}`, err);
  }
}

// ---------------------------------------------------------------------------
// updatePaymentStatus
// ---------------------------------------------------------------------------
// Called by PaymentService when polling detects a status change,
// or by WebhookService when a webhook updates the payment state.

export async function updatePaymentStatus(chkId: string, status: PaymentStatus): Promise<void> {
  try {
    const key = Keys.payment(chkId);

    const exists = await redisClient.hexists(key, 'chkId');
    if (!exists) {
      throw new StoreError(
        `updatePaymentStatus:${chkId}`,
        new Error(`Payment record not found for chkId: ${chkId}`),
      );
    }

    await redisClient.hset(key, {
      status,
      updatedAt: now(),
    });
  } catch (err) {
    if (err instanceof StoreError) throw err;
    throw new StoreError(`updatePaymentStatus:${chkId}`, err);
  }
}

// ---------------------------------------------------------------------------
// updateGatewayPaymentId
// ---------------------------------------------------------------------------
// Called by WebhookService when payment.captured webhook arrives.
//
// Two things happen atomically:
//   1. gatewayPaymentId field on the StoredPayment hash is set to pay_XXXX
//   2. A second reverse lookup key is written for pay_XXXX → chk_id
//      so future webhook events (refund.processed etc.) can also correlate
//
// This is the Option C contract — gatewayPaymentId is empty at creation
// and is the only ID valid for createRefund(). Services must read it from
// the store after this function has been called.

export async function updateGatewayPaymentId(
  chkId: string,
  gateway: string,
  gatewayPaymentId: string,
): Promise<void> {
  try {
    const key = Keys.payment(chkId);

    const exists = await redisClient.hexists(key, 'chkId');
    if (!exists) {
      throw new StoreError(
        `updateGatewayPaymentId:${chkId}`,
        new Error(`Payment record not found for chkId: ${chkId}`),
      );
    }

    const pipeline = redisClient.pipeline();

    // Update gatewayPaymentId on the payment hash
    pipeline.hset(key, {
      gatewayPaymentId,
      updatedAt: now(),
    });

    // Register the pay_XXXX reverse lookup so refund.processed webhooks
    // can also be correlated back to this chk_ record.
    pipeline.set(Keys.gatewayLookup(gateway, gatewayPaymentId), chkId);

    await pipeline.exec();
  } catch (err) {
    if (err instanceof StoreError) throw err;
    throw new StoreError(`updateGatewayPaymentId:${chkId}`, err);
  }
}
