// refund.store.ts
// All Redis operations for refund records.

// Key patterns used:
//   chk:ref:{ref_id}          → Hash   — full StoredRefund record
//   chk:ref:by-pay:{chk_id}   → Set    — all ref_ids for a payment
//   (used to check total refunded amount)

import { redisClient } from './redis.client';
import { StoreError } from '../errors/store.errors';
import { now } from '../utils/time';
import type { StoreRefund } from '../types/payment.types';
import { RefundStatus } from '../types/payment.types';

const Keys = {
  refund: (refId: string): string => `chk:ref:${refId}`,
  refundsByPayment: (chkId: string): string => `chk:ref:by-pay:${chkId}`,
};

function serialiseRefund(refund: StoreRefund): Record<string, string> {
  return {
    refId: refund.refId,
    chkId: refund.chkId,
    gatewayRefundId: refund.gatewayRefundId,
    gateway: refund.gateway,
    amount: String(refund.amount),
    currency: refund.currency,
    status: refund.status,
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
  };
}

function deserialiseRefund(raw: Record<string, string>): StoreRefund {
  return {
    refId: raw['refId'] ?? '',
    chkId: raw['chkId'] ?? '',
    gatewayRefundId: raw['gatewayRefundId'] ?? '',
    gateway: raw['gateway'] as StoreRefund['gateway'],
    amount: parseInt(raw['amount'] ?? '0', 10),
    currency: raw['currency'] as StoreRefund['currency'],
    status: raw['status'] as RefundStatus,
    createdAt: raw['createdAt'] ?? '',
    updatedAt: raw['updatedAt'] ?? '',
  };
}

export async function saveRefund(refund: StoreRefund): Promise<void> {
  try {
    const pipeline = redisClient.pipeline();

    // Write the full refund hash
    pipeline.hset(Keys.refund(refund.refId), serialiseRefund(refund));

    // Register this refund against its parent payment.
    // SADD is idempotent — safe to call multiple times with same value.
    pipeline.sadd(Keys.refundsByPayment(refund.chkId), refund.refId);

    await pipeline.exec();
  } catch (err) {
    throw new StoreError(`saveRefund:${refund.refId}`, err);
  }
}

export async function findRefundByRefId(refId: string): Promise<StoreRefund | null> {
  try {
    const raw = await redisClient.hgetall(Keys.refund(refId));

    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }

    return deserialiseRefund(raw);
  } catch (err) {
    throw new StoreError(`findRefundByRefId:${refId}`, err);
  }
}

export async function findRefundsByChkId(chkId: string): Promise<StoreRefund[]> {
  try {
    // Step 1: Get all ref_ids registered for this payment
    const refIds = await redisClient.smembers(Keys.refundsByPayment(chkId));

    if (refIds.length === 0) {
      return [];
    }

    // Step 2: Fetch all refund hashes in a single pipeline
    const pipeline = redisClient.pipeline();
    for (const refId of refIds) {
      pipeline.hgetall(Keys.refund(refId));
    }

    const results = await pipeline.exec();

    if (!results) return [];

    // Step 3: Deserialise — filter out any null results from pipeline
    const refunds: StoreRefund[] = [];
    for (const [err, raw] of results) {
      if (err || !raw || Object.keys(raw as object).length === 0) continue;
      refunds.push(deserialiseRefund(raw as Record<string, string>));
    }

    return refunds;
  } catch (err) {
    throw new StoreError(`findRefundsByChkId:${chkId}`, err);
  }
}

export async function updateRefundStatus(refId: string, status: RefundStatus): Promise<void> {
  try {
    const key = Keys.refund(refId);

    const exists = await redisClient.hexists(key, 'refId');
    if (!exists) {
      throw new StoreError(
        `updateRefundStatus:${refId}`,
        new Error(`Refund record not found for refId: ${refId}`),
      );
    }

    await redisClient.hset(key, {
      status,
      updatedAt: now(),
    });
  } catch (err) {
    if (err instanceof StoreError) throw err;
    throw new StoreError(`updateRefundStatus:${refId}`, err);
  }
}
