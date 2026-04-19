// tests/integration/store/payment.store.test.ts
// Integration tests for payment.store.ts against real Redis.
//
// Business invariants protected:
//   - savePayment writes all fields correctly and sets reverse lookup key
//   - findPaymentByChkId returns exact stored shape
//   - findChkIdByGatewayId resolves both gatewayOrderId and gatewayPaymentId
//   - updatePaymentStatus changes only status + updatedAt
//   - updateGatewayPaymentId sets hash field AND writes second reverse lookup
//   - Missing records return null cleanly without throwing
//
// Prerequisites: Redis running on localhost:6379
//   docker start checkoutos-redis

import { describe, it, expect, beforeEach } from 'vitest';
import {
  savePayment,
  findPaymentByChkId,
  findChkIdByGatewayId,
  updatePaymentStatus,
  updateGatewayPaymentId,
} from '../../../src/store/payment.store';
import { redisClient } from '../../../src/store/redis.client';
import { PaymentStatus } from '../../../src/types/payment.types';
import type { StoredPayment } from '../../../src/types/payment.types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStoredPayment(overrides: Partial<StoredPayment> = {}): StoredPayment {
  return {
    chkId: 'chk_integtest00000000000000000001',
    gatewayOrderId: 'order_integtest001',
    gatewayPaymentId: '',
    gateway: 'razorpay',
    orderId: 'dev_order_001',
    amount: 50000,
    currency: 'INR',
    status: PaymentStatus.PENDING,
    createdAt: '2024-01-15T10:30:00.000Z',
    updatedAt: '2024-01-15T10:30:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// savePayment + findPaymentByChkId
// ---------------------------------------------------------------------------

describe('savePayment + findPaymentByChkId', () => {
  it('saves a payment and retrieves it by chkId', async () => {
    const payment = makeStoredPayment();
    await savePayment(payment);

    const found = await findPaymentByChkId(payment.chkId);

    expect(found).not.toBeNull();
    expect(found!.chkId).toBe(payment.chkId);
    expect(found!.gatewayOrderId).toBe('order_integtest001');
    expect(found!.gatewayPaymentId).toBe('');
    expect(found!.gateway).toBe('razorpay');
    expect(found!.orderId).toBe('dev_order_001');
    expect(found!.status).toBe(PaymentStatus.PENDING);
  });

  it('deserialises amount as a number (not a string)', async () => {
    const payment = makeStoredPayment({ amount: 75000 });
    await savePayment(payment);

    const found = await findPaymentByChkId(payment.chkId);

    // Redis stores everything as strings — deserialisePayment must convert back
    expect(typeof found!.amount).toBe('number');
    expect(found!.amount).toBe(75000);
  });

  it('preserves all fields through a full round-trip', async () => {
    const payment = makeStoredPayment({
      chkId: 'chk_integtest00000000000000000002',
      gatewayOrderId: 'order_roundtrip001',
      gatewayPaymentId: 'pay_roundtrip001',
      gateway: 'razorpay',
      orderId: 'dev_order_roundtrip',
      amount: 99900,
      currency: 'INR',
      status: PaymentStatus.SUCCESS,
      createdAt: '2024-01-15T10:30:00.000Z',
      updatedAt: '2024-01-15T11:00:00.000Z',
    });

    await savePayment(payment);
    const found = await findPaymentByChkId(payment.chkId);

    expect(found).toEqual(payment);
  });

  it('returns null for a chkId that does not exist', async () => {
    const found = await findPaymentByChkId('chk_doesnotexist00000000000000');
    expect(found).toBeNull();
  });

  it('overwrites an existing payment when saved again with same chkId', async () => {
    const payment = makeStoredPayment();
    await savePayment(payment);

    const updated = makeStoredPayment({ status: PaymentStatus.SUCCESS });
    await savePayment(updated);

    const found = await findPaymentByChkId(payment.chkId);
    expect(found!.status).toBe(PaymentStatus.SUCCESS);
  });
});

// ---------------------------------------------------------------------------
// findChkIdByGatewayId — reverse lookup
// ---------------------------------------------------------------------------

describe('findChkIdByGatewayId', () => {
  it('finds chkId via gatewayOrderId reverse lookup set at creation', async () => {
    const payment = makeStoredPayment();
    await savePayment(payment);

    const chkId = await findChkIdByGatewayId('razorpay', 'order_integtest001');
    expect(chkId).toBe('chk_integtest00000000000000000001');
  });

  it('returns null for a gatewayId that was never registered', async () => {
    const chkId = await findChkIdByGatewayId('razorpay', 'order_neverstored');
    expect(chkId).toBeNull();
  });

  it('finds chkId via gatewayPaymentId after updateGatewayPaymentId is called', async () => {
    const payment = makeStoredPayment({
      chkId: 'chk_integtest00000000000000000003',
      gatewayOrderId: 'order_forupdate001',
    });
    await savePayment(payment);

    await updateGatewayPaymentId(payment.chkId, 'razorpay', 'pay_newpaymentid001');

    const chkId = await findChkIdByGatewayId('razorpay', 'pay_newpaymentid001');
    expect(chkId).toBe('chk_integtest00000000000000000003');
  });
});

// ---------------------------------------------------------------------------
// updatePaymentStatus
// ---------------------------------------------------------------------------

describe('updatePaymentStatus', () => {
  it('updates status field on the stored payment', async () => {
    const payment = makeStoredPayment({
      chkId: 'chk_integtest00000000000000000004',
      status: PaymentStatus.PENDING,
    });
    await savePayment(payment);

    await updatePaymentStatus(payment.chkId, PaymentStatus.SUCCESS);

    const found = await findPaymentByChkId(payment.chkId);
    expect(found!.status).toBe(PaymentStatus.SUCCESS);
  });

  it('updates updatedAt timestamp', async () => {
    const payment = makeStoredPayment({
      chkId: 'chk_integtest00000000000000000005',
      updatedAt: '2024-01-15T10:30:00.000Z',
    });
    await savePayment(payment);

    await updatePaymentStatus(payment.chkId, PaymentStatus.SUCCESS);

    const found = await findPaymentByChkId(payment.chkId);
    // updatedAt should have changed from the original
    expect(found!.updatedAt).not.toBe('2024-01-15T10:30:00.000Z');
  });

  it('does not change other fields when updating status', async () => {
    const payment = makeStoredPayment({
      chkId: 'chk_integtest00000000000000000006',
      amount: 12345,
      orderId: 'preserve_this_order_id',
    });
    await savePayment(payment);

    await updatePaymentStatus(payment.chkId, PaymentStatus.FAILED);

    const found = await findPaymentByChkId(payment.chkId);
    expect(found!.amount).toBe(12345);
    expect(found!.orderId).toBe('preserve_this_order_id');
    expect(found!.gatewayOrderId).toBe('order_integtest001');
  });

  it('throws StoreError for a chkId that does not exist', async () => {
    await expect(
      updatePaymentStatus('chk_doesnotexist00000000000000', PaymentStatus.SUCCESS),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// updateGatewayPaymentId (Option C)
// ---------------------------------------------------------------------------

describe('updateGatewayPaymentId', () => {
  it('sets gatewayPaymentId on the stored payment hash', async () => {
    const payment = makeStoredPayment({
      chkId: 'chk_integtest00000000000000000007',
      gatewayOrderId: 'order_optionc001',
      gatewayPaymentId: '',
    });
    await savePayment(payment);

    await updateGatewayPaymentId(payment.chkId, 'razorpay', 'pay_optionc001');

    const found = await findPaymentByChkId(payment.chkId);
    expect(found!.gatewayPaymentId).toBe('pay_optionc001');
  });

  it('writes a second reverse lookup key for the pay_ ID', async () => {
    // This is the critical Option C test — the pay_ reverse lookup must
    // exist so refund.processed webhooks can correlate back to chk_ ID
    const payment = makeStoredPayment({
      chkId: 'chk_integtest00000000000000000008',
      gatewayOrderId: 'order_optionc002',
      gatewayPaymentId: '',
    });
    await savePayment(payment);

    await updateGatewayPaymentId(payment.chkId, 'razorpay', 'pay_optionc002');

    // Both lookups must work after this call
    const viaOrder = await findChkIdByGatewayId('razorpay', 'order_optionc002');
    const viaPayment = await findChkIdByGatewayId('razorpay', 'pay_optionc002');

    expect(viaOrder).toBe('chk_integtest00000000000000000008');
    expect(viaPayment).toBe('chk_integtest00000000000000000008');
  });

  it('does not overwrite gatewayOrderId when setting gatewayPaymentId', async () => {
    const payment = makeStoredPayment({
      chkId: 'chk_integtest00000000000000000009',
      gatewayOrderId: 'order_preserve001',
    });
    await savePayment(payment);

    await updateGatewayPaymentId(payment.chkId, 'razorpay', 'pay_preserve001');

    const found = await findPaymentByChkId(payment.chkId);
    expect(found!.gatewayOrderId).toBe('order_preserve001');
    expect(found!.gatewayPaymentId).toBe('pay_preserve001');
  });

  it('throws StoreError for a chkId that does not exist', async () => {
    await expect(
      updateGatewayPaymentId('chk_doesnotexist00000000000000', 'razorpay', 'pay_test'),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pipeline atomicity check
// ---------------------------------------------------------------------------

describe('savePayment — pipeline atomicity', () => {
  it('writes both hash and reverse lookup key in the same pipeline call', async () => {
    const payment = makeStoredPayment({
      chkId: 'chk_integtest00000000000000000010',
      gatewayOrderId: 'order_atomic001',
    });
    await savePayment(payment);

    // Both must exist after a single savePayment call
    const hashExists = await redisClient.hexists(`chk:pay:${payment.chkId}`, 'chkId');
    const lookupExists = await redisClient.exists(`chk:gw:razorpay:order_atomic001`);

    expect(hashExists).toBe(1);
    expect(lookupExists).toBe(1);
  });
});
