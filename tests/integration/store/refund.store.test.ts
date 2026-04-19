// tests/integration/store/refund.store.test.ts
// Integration tests for refund.store.ts against real Redis.
//
// Business invariants protected:
//   - saveRefund writes all fields and registers refId in the payment's Set
//   - findRefundByRefId returns exact stored shape
//   - findRefundsByChkId returns all refunds for a payment (used for amount validation)
//   - updateRefundStatus changes only status + updatedAt
//   - Multiple refunds against the same payment are all tracked correctly
//
// Prerequisites: Redis running on localhost:6379
//   docker start checkoutos-redis

import { describe, it, expect } from 'vitest';
import {
  saveRefund,
  findRefundByRefId,
  findRefundsByChkId,
  updateRefundStatus,
} from '../../../src/store/refund.store';
import { RefundStatus } from '../../../src/types/payment.types';
import type { StoreRefund } from '../../../src/types/payment.types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStoreRefund(overrides: Partial<StoreRefund> = {}): StoreRefund {
  return {
    refId: 'ref_integtest00000000000000000001',
    chkId: 'chk_integtest00000000000000000001',
    gatewayRefundId: 'rfnd_integtest001',
    gateway: 'razorpay',
    amount: 50000,
    currency: 'INR',
    status: RefundStatus.PENDING,
    createdAt: '2024-01-15T10:30:00.000Z',
    updatedAt: '2024-01-15T10:30:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// saveRefund + findRefundByRefId
// ---------------------------------------------------------------------------

describe('saveRefund + findRefundByRefId', () => {
  it('saves a refund and retrieves it by refId', async () => {
    const refund = makeStoreRefund();
    await saveRefund(refund);

    const found = await findRefundByRefId(refund.refId);

    expect(found).not.toBeNull();
    expect(found!.refId).toBe(refund.refId);
    expect(found!.chkId).toBe(refund.chkId);
    expect(found!.gatewayRefundId).toBe('rfnd_integtest001');
    expect(found!.status).toBe(RefundStatus.PENDING);
  });

  it('deserialises amount as a number', async () => {
    const refund = makeStoreRefund({ amount: 25000 });
    await saveRefund(refund);

    const found = await findRefundByRefId(refund.refId);

    expect(typeof found!.amount).toBe('number');
    expect(found!.amount).toBe(25000);
  });

  it('preserves all fields through a full round-trip', async () => {
    const refund = makeStoreRefund({
      refId: 'ref_integtest00000000000000000002',
      chkId: 'chk_integtest00000000000000000002',
      gatewayRefundId: 'rfnd_roundtrip001',
      gateway: 'razorpay',
      amount: 30000,
      currency: 'INR',
      status: RefundStatus.SUCCESS,
      createdAt: '2024-01-15T10:30:00.000Z',
      updatedAt: '2024-01-15T11:00:00.000Z',
    });

    await saveRefund(refund);
    const found = await findRefundByRefId(refund.refId);

    expect(found).toEqual(refund);
  });

  it('returns null for a refId that does not exist', async () => {
    const found = await findRefundByRefId('ref_doesnotexist0000000000000000');
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findRefundsByChkId
// ---------------------------------------------------------------------------

describe('findRefundsByChkId', () => {
  it('returns empty array when no refunds exist for a chkId', async () => {
    const refunds = await findRefundsByChkId('chk_neverrefunded000000000000000');
    expect(refunds).toEqual([]);
  });

  it('returns all refunds for a payment with one refund', async () => {
    const refund = makeStoreRefund({
      refId: 'ref_integtest00000000000000000003',
      chkId: 'chk_integtest00000000000000000003',
    });
    await saveRefund(refund);

    const refunds = await findRefundsByChkId('chk_integtest00000000000000000003');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.refId).toBe(refund.refId);
  });

  it('returns all refunds for a payment with multiple refunds', async () => {
    // This simulates partial refunds — the total must add up correctly
    const chkId = 'chk_integtest00000000000000000004';

    const refund1 = makeStoreRefund({
      refId: 'ref_integtest00000000000000000004',
      chkId,
      amount: 20000,
      gatewayRefundId: 'rfnd_partial001',
    });

    const refund2 = makeStoreRefund({
      refId: 'ref_integtest00000000000000000005',
      chkId,
      amount: 10000,
      gatewayRefundId: 'rfnd_partial002',
    });

    await saveRefund(refund1);
    await saveRefund(refund2);

    const refunds = await findRefundsByChkId(chkId);
    expect(refunds).toHaveLength(2);

    const totalRefunded = refunds.reduce((sum, r) => sum + r.amount, 0);
    expect(totalRefunded).toBe(30000);
  });

  it('does not return refunds for a different chkId', async () => {
    const refundA = makeStoreRefund({
      refId: 'ref_integtest00000000000000000006',
      chkId: 'chk_integtest00000000000000000005',
    });
    const refundB = makeStoreRefund({
      refId: 'ref_integtest00000000000000000007',
      chkId: 'chk_integtest00000000000000000006',
    });

    await saveRefund(refundA);
    await saveRefund(refundB);

    const refundsA = await findRefundsByChkId('chk_integtest00000000000000000005');
    const refundsB = await findRefundsByChkId('chk_integtest00000000000000000006');

    expect(refundsA).toHaveLength(1);
    expect(refundsA[0]!.refId).toBe(refundA.refId);
    expect(refundsB).toHaveLength(1);
    expect(refundsB[0]!.refId).toBe(refundB.refId);
  });

  it('saveRefund is idempotent — adding same refId twice does not duplicate', async () => {
    const refund = makeStoreRefund({
      refId: 'ref_integtest00000000000000000008',
      chkId: 'chk_integtest00000000000000000007',
    });

    await saveRefund(refund);
    await saveRefund(refund); // second call — SADD is idempotent

    const refunds = await findRefundsByChkId('chk_integtest00000000000000000007');
    expect(refunds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateRefundStatus
// ---------------------------------------------------------------------------

describe('updateRefundStatus', () => {
  it('updates status field on the stored refund', async () => {
    const refund = makeStoreRefund({
      refId: 'ref_integtest00000000000000000009',
      chkId: 'chk_integtest00000000000000000008',
      status: RefundStatus.PENDING,
    });
    await saveRefund(refund);

    await updateRefundStatus(refund.refId, RefundStatus.SUCCESS);

    const found = await findRefundByRefId(refund.refId);
    expect(found!.status).toBe(RefundStatus.SUCCESS);
  });

  it('updates updatedAt timestamp', async () => {
    const refund = makeStoreRefund({
      refId: 'ref_integtest00000000000000000010',
      chkId: 'chk_integtest00000000000000000009',
      updatedAt: '2024-01-15T10:30:00.000Z',
    });
    await saveRefund(refund);

    await updateRefundStatus(refund.refId, RefundStatus.SUCCESS);

    const found = await findRefundByRefId(refund.refId);
    expect(found!.updatedAt).not.toBe('2024-01-15T10:30:00.000Z');
  });

  it('does not change other fields when updating status', async () => {
    const refund = makeStoreRefund({
      refId: 'ref_integtest00000000000000000011',
      chkId: 'chk_integtest00000000000000000010',
      amount: 77777,
      gatewayRefundId: 'rfnd_preserve001',
    });
    await saveRefund(refund);

    await updateRefundStatus(refund.refId, RefundStatus.FAILED);

    const found = await findRefundByRefId(refund.refId);
    expect(found!.amount).toBe(77777);
    expect(found!.gatewayRefundId).toBe('rfnd_preserve001');
    expect(found!.chkId).toBe('chk_integtest00000000000000000010');
  });

  it('throws StoreError for a refId that does not exist', async () => {
    await expect(
      updateRefundStatus('ref_doesnotexist0000000000000000', RefundStatus.SUCCESS),
    ).rejects.toThrow();
  });
});
