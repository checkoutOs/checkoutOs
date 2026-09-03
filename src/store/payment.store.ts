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
import { ORDER_RESERVATION_TTL_SECONDS } from '../types/common.types';

// ---------------------------------------------------------------------------
// Key builders

const Keys = {
  payment: (chkId: string): string => `chk:pay:${chkId}`,

  // Reverse lookup — maps any gateway-native ID back to a chk_ ID.
  // Used twice per payment lifecycle:
  //   1. At creation with gatewayOrderId (order_XXXX)
  //   2. After webhook with gatewayPaymentId (pay_XXXX)
  gatewayLookup: (gateway: string, gwId: string): string => `chk:gw:${gateway}:${gwId}`,

  // reverse lookup for idempotency fallback
  // maps a merchant supplied orderId to the internal chk_ ID
  orderLookup: (orderId: string): string => `chk:pay:by-order:${orderId}`,
};

// Lua: commit the orderId index. Writes only when the key is absent or already
// holds this caller's chkId; returns 0 when another request owns it.
//
// SET without an expiry clears any TTL, which is how a reservation taken by
// reserveOrderId() is promoted from temporary claim to permanent index.
const COMMIT_ORDER_LOOKUP_SCRIPT = `
local key = KEYS[1]
local chkId = ARGV[1]

local current = redis.call("GET", key)
if current and current ~= chkId then
    return 0
end

redis.call("SET", key, chkId)
return 1
`;

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
    // gatewayMetadata is stored as a compact JSON string.
    // Only written when the gateway contributed metadata (e.g. Paytm paymentUrl).
    // Absent entirely for gateways that need no extra data (e.g. Razorpay).
    ...(payment.gatewayMetadata && Object.keys(payment.gatewayMetadata).length > 0
      ? { gatewayMetadata: JSON.stringify(payment.gatewayMetadata) }
      : {}),
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

function deserialisePayment(raw: Record<string, string>): StoredPayment {
  // Parse gatewayMetadata from JSON string. Treat malformed JSON as absent —
  // a corrupted metadata field must never prevent a payment from being read.
  let gatewayMetadata: Record<string, string> | undefined;
  if (raw['gatewayMetadata']) {
    try {
      const parsed: unknown = JSON.parse(raw['gatewayMetadata']);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        gatewayMetadata = parsed as Record<string, string>;
      }
    } catch {
      // Silently ignore — malformed metadata does not block payment reads.
    }
  }

  return {
    chkId: raw['chkId'] ?? '',
    gatewayOrderId: raw['gatewayOrderId'] ?? '',
    gatewayPaymentId: raw['gatewayPaymentId'] ?? '',
    gateway: raw['gateway'] as StoredPayment['gateway'],
    orderId: raw['orderId'] ?? '',
    amount: parseInt(raw['amount'] ?? '0', 10),
    currency: raw['currency'] as StoredPayment['currency'],
    status: raw['status'] as PaymentStatus,
    ...(gatewayMetadata !== undefined ? { gatewayMetadata } : {}),
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

    // Reverse lookup for orderId → chk_id — commits the reservation taken by
    // reserveOrderId() before the gateway call, dropping its TTL so the index
    // becomes permanent.
    //
    // Guarded rather than a plain SET: if this process was slow enough that its
    // reservation expired and another request claimed the orderId, overwriting
    // would silently steal their index entry and orphan their payment. In that
    // case we leave their key alone — this payment stays reachable by chkId and
    // via the gateway-id lookup, which is the safe way to lose the race.
    await commitOrderLookup(payment.orderId, payment.chkId);
  } catch (err) {
    throw new StoreError(`savePayment:${payment.chkId}`, err);
  }
}

// ---------------------------------------------------------------------------
// reserveOrderId
// ---------------------------------------------------------------------------
// Atomically claim an orderId before calling the gateway.
//
// This is what makes orderId deduplication concurrency-safe. Without it,
// findPaymentByOrderId() and savePayment() form a check-then-act pair with a
// full gateway round-trip in between: two concurrent requests carrying the same
// orderId both read "no payment", both create a gateway order, and the second
// save clobbers the first's index — two live orders for one merchant order.
//
// Returns true if the caller now owns the orderId, false if someone else does
// (either an in-flight reservation or a committed payment).
//
// The reservation holds the caller's chkId, so a reservation that is never
// committed resolves to null through findPaymentByOrderId()'s two-step lookup
// (the payment hash does not exist yet). No sentinel value is needed and no
// reader has to know reservations exist.

export async function reserveOrderId(orderId: string, chkId: string): Promise<boolean> {
  try {
    const result = await redisClient.set(
      Keys.orderLookup(orderId),
      chkId,
      'EX',
      ORDER_RESERVATION_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  } catch (err) {
    throw new StoreError(`reserveOrderId:${orderId}`, err);
  }
}

// Commit the orderId index: write it permanently (no TTL), but only if the key
// is absent or still holds our own chkId. Returns true when written.
async function commitOrderLookup(orderId: string, chkId: string): Promise<boolean> {
  const result = await redisClient.eval(
    COMMIT_ORDER_LOOKUP_SCRIPT,
    1,
    Keys.orderLookup(orderId),
    chkId,
  );
  return result === 1;
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

export async function findPaymentByOrderId(orderId: string): Promise<StoredPayment | null> {
  try {
    const chkId = await redisClient.get(Keys.orderLookup(orderId));
    if (!chkId) {
      return null;
    }
    return await findPaymentByChkId(chkId);
  } catch (err) {
    throw new StoreError(`findPaymentByOrderId:${orderId}`, err);
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
