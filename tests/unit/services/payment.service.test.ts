// tests/unit/services/payment.service.test.ts
// Tests for PaymentService business logic.
//
// Business invariants protected:
//   - Amount validation rejects zero, negative, and non-integer values
//   - StoredPayment is saved with empty gatewayPaymentId (Option C)
//   - StoredPayment is saved with correct gatewayOrderId from gateway result
//   - Terminal statuses never trigger gateway re-poll
//   - Non-terminal statuses re-poll only when stale (> 10s)
//   - validateAndPrepareRefund blocks refunds on wrong status
//   - validateAndPrepareRefund blocks when gatewayPaymentId is empty
//   - Refund amount validation catches exceeding remaining refundable amount

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentStatus, RefundStatus } from '../../../src/types/payment.types';
import type { StoredPayment, StoreRefund } from '../../../src/types/payment.types';
import {
  InvalidAmountError,
  PaymentNotFoundError,
  RefundNotAllowedError,
  RefundAmountExceedsPaymentError,
} from '../../../src/errors';

// ---------------------------------------------------------------------------
// Mock all external dependencies
// ---------------------------------------------------------------------------
// Services must never touch real Redis or real Razorpay in unit tests.

vi.mock('../../../src/store/payment.store', () => ({
  savePayment: vi.fn().mockResolvedValue(undefined),
  findPaymentByChkId: vi.fn(),
  updatePaymentStatus: vi.fn().mockResolvedValue(undefined),
  updateGatewayPaymentId: vi.fn().mockResolvedValue(undefined),
  findChkIdByGatewayId: vi.fn(),
}));

vi.mock('../../../src/store/refund.store', () => ({
  findRefundsByChkId: vi.fn().mockResolvedValue([]),
  saveRefund: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/gateways/gateway.registry', () => ({
  getActiveGateway: vi.fn(),
  // Re-export registry constants consumed by config/index.ts at module load
  supportedGateways: ['razorpay', 'payu', 'cashfree'] as const,
  gatewayEnvDefinitions: {
    razorpay: {
      requiredEnvKeys: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
      defaultBaseUrl: 'https://api.razorpay.com/v1',
      baseUrlEnvKey: 'RAZORPAY_BASE_URL',
    },
    payu: {
      requiredEnvKeys: ['PAYU_MERCHANT_KEY', 'PAYU_MERCHANT_SALT', 'PAYU_WEBHOOK_SECRET'],
      defaultBaseUrl: 'https://api.payu.in',
      baseUrlEnvKey: 'PAYU_BASE_URL',
    },
    cashfree: {
      requiredEnvKeys: ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY', 'CASHFREE_WEBHOOK_SECRET'],
      defaultBaseUrl: 'https://api.cashfree.com',
      baseUrlEnvKey: 'CASHFREE_BASE_URL',
    },
  },
  gatewayCredentialEnvKeys: {
    razorpay: {
      keyId: 'RAZORPAY_KEY_ID',
      keySecret: 'RAZORPAY_KEY_SECRET',
      webhookSecret: 'RAZORPAY_WEBHOOK_SECRET',
    },
    payu: {
      merchantKey: 'PAYU_MERCHANT_KEY',
      merchantSalt: 'PAYU_MERCHANT_SALT',
      webhookSecret: 'PAYU_WEBHOOK_SECRET',
    },
    cashfree: {
      appId: 'CASHFREE_APP_ID',
      secretKey: 'CASHFREE_SECRET_KEY',
      webhookSecret: 'CASHFREE_WEBHOOK_SECRET',
    },
  },
  registerGateways: vi.fn(),
  buildActiveGatewayCredentials: vi.fn().mockReturnValue({
    keyId: 'rzp_test_mockKeyId00001',
    keySecret: 'mockSecret00001',
    webhookSecret: 'mockWebhookSecret001',
  }),
  isSupportedGatewayName: vi.fn().mockReturnValue(true),
  getGatewayByName: vi.fn().mockReturnValue('razorpay'),
}));

vi.mock('../../../src/utils/id', () => ({
  generatePaymentId: vi.fn().mockReturnValue('chk_testpaymentid12345678901234'),
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import {
  createPayment,
  getPaymentStatus,
  validateAndPrepareRefund,
} from '../../../src/services/payments.service';
import {
  savePayment,
  findPaymentByChkId,
  updatePaymentStatus,
} from '../../../src/store/payment.store';
import { findRefundsByChkId } from '../../../src/store/refund.store';
import { getActiveGateway } from '../../../src/gateways/gateway.registry';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockGatewayPlugin = {
  name: 'razorpay',
  createPayment: vi.fn(),
  getPaymentStatus: vi.fn(),
  createRefund: vi.fn(),
  getRefundStatus: vi.fn(),
  parseWebhookEvent: vi.fn(),
  healthCheck: vi.fn(),
};

const mockStoredPayment: StoredPayment = {
  chkId: 'chk_testpaymentid12345678901234',
  gatewayOrderId: 'order_mock001',
  gatewayPaymentId: 'pay_mock001',
  gateway: 'razorpay',
  orderId: 'order_test_001',
  amount: 50000,
  currency: 'INR',
  status: PaymentStatus.SUCCESS,
  createdAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
  updatedAt: new Date(Date.now() - 60_000).toISOString(), // stale
};

const baseCreateRequest = {
  amount: 50000,
  currency: 'INR' as const,
  orderId: 'order_test_001',
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveGateway).mockReturnValue(mockGatewayPlugin as never);

  mockGatewayPlugin.createPayment.mockResolvedValue({
    gatewayId: 'order_mock001',
    status: PaymentStatus.PENDING,
    amount: 50000,
    currency: 'INR',
    paymentUrl: 'https://checkout.razorpay.com/test',
  });

  mockGatewayPlugin.getPaymentStatus.mockResolvedValue({
    gatewayId: 'order_mock001',
    status: PaymentStatus.SUCCESS,
    amount: 50000,
    currency: 'INR',
  });
});

// ---------------------------------------------------------------------------
// createPayment — amount validation
// ---------------------------------------------------------------------------

describe('createPayment — amount validation', () => {
  it('throws InvalidAmountError for zero amount', async () => {
    await expect(createPayment({ ...baseCreateRequest, amount: 0 })).rejects.toThrow(
      InvalidAmountError,
    );
  });

  it('throws InvalidAmountError for negative amount', async () => {
    await expect(createPayment({ ...baseCreateRequest, amount: -100 })).rejects.toThrow(
      InvalidAmountError,
    );
  });

  it('throws InvalidAmountError for non-integer amount', async () => {
    await expect(createPayment({ ...baseCreateRequest, amount: 499.99 })).rejects.toThrow(
      InvalidAmountError,
    );
  });

  it('accepts a positive integer amount', async () => {
    await expect(createPayment({ ...baseCreateRequest, amount: 50000 })).resolves.not.toThrow();
  });

  it('accepts minimum valid amount of 1 paise', async () => {
    mockGatewayPlugin.createPayment.mockResolvedValueOnce({
      gatewayId: 'order_min',
      status: PaymentStatus.PENDING,
      amount: 1,
      currency: 'INR',
      paymentUrl: 'https://checkout.razorpay.com/test',
    });

    await expect(createPayment({ ...baseCreateRequest, amount: 1 })).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createPayment — Option C: StoredPayment shape
// ---------------------------------------------------------------------------

describe('createPayment — StoredPayment saved correctly', () => {
  it('saves StoredPayment with empty gatewayPaymentId (Option C)', async () => {
    await createPayment(baseCreateRequest);

    const savedPayment = vi.mocked(savePayment).mock.calls[0][0];
    expect(savedPayment.gatewayPaymentId).toBe('');
  });

  it('saves StoredPayment with gatewayOrderId from gateway result', async () => {
    await createPayment(baseCreateRequest);

    const savedPayment = vi.mocked(savePayment).mock.calls[0][0];
    expect(savedPayment.gatewayOrderId).toBe('order_mock001');
  });

  it('saves StoredPayment with correct amount and currency', async () => {
    await createPayment(baseCreateRequest);

    const savedPayment = vi.mocked(savePayment).mock.calls[0][0];
    expect(savedPayment.amount).toBe(50000);
    expect(savedPayment.currency).toBe('INR');
  });

  it('saves StoredPayment with PENDING status', async () => {
    await createPayment(baseCreateRequest);

    const savedPayment = vi.mocked(savePayment).mock.calls[0][0];
    expect(savedPayment.status).toBe(PaymentStatus.PENDING);
  });

  it('returns paymentId with chk_ prefix', async () => {
    const result = await createPayment(baseCreateRequest);
    expect(result.paymentId).toMatch(/^chk_/);
  });

  it('returns hosted checkout URL (CheckoutOS page)', async () => {
    const result = await createPayment(baseCreateRequest);

    expect(result.paymentUrl).toBe(`//checkout/chk_testpaymentid12345678901234`);
  });

  it('returns correct status from gateway result', async () => {
    const result = await createPayment(baseCreateRequest);
    expect(result.status).toBe(PaymentStatus.PENDING);
  });

  it('stores gateway paymentUrl in gatewayMetadata when gateway returns one', async () => {
    // The mock createPayment returns paymentUrl — service must store it in gatewayMetadata
    await createPayment(baseCreateRequest);

    const savedPayment = vi.mocked(savePayment).mock.calls[0][0];
    expect(savedPayment.gatewayMetadata).toBeDefined();
    expect(savedPayment.gatewayMetadata?.['paymentUrl']).toBe('https://checkout.razorpay.com/test');
  });

  it('omits gatewayMetadata entirely when gateway returns no paymentUrl', async () => {
    // Gateway result without paymentUrl — field must be absent, not empty object
    mockGatewayPlugin.createPayment.mockResolvedValueOnce({
      gatewayId: 'order_nopaymenturl',
      status: PaymentStatus.PENDING,
      amount: 50000,
      currency: 'INR',
      // No paymentUrl field
    });

    await createPayment(baseCreateRequest);

    const savedPayment = vi.mocked(savePayment).mock.calls[0][0];
    expect(savedPayment.gatewayMetadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getPaymentStatus — re-poll strategy
// ---------------------------------------------------------------------------

describe('getPaymentStatus — re-poll strategy', () => {
  it('throws PaymentNotFoundError when payment not in Redis', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce(null);

    await expect(getPaymentStatus('chk_notexist')).rejects.toThrow(PaymentNotFoundError);
  });

  it('does NOT re-poll gateway for terminal SUCCESS status', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.SUCCESS,
    });

    await getPaymentStatus('chk_testpaymentid12345678901234');

    expect(mockGatewayPlugin.getPaymentStatus).not.toHaveBeenCalled();
  });

  it('does NOT re-poll gateway for terminal FAILED status', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.FAILED,
    });

    await getPaymentStatus('chk_testpaymentid12345678901234');

    expect(mockGatewayPlugin.getPaymentStatus).not.toHaveBeenCalled();
  });

  it('does NOT re-poll gateway for terminal REFUNDED status', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.REFUNDED,
    });

    await getPaymentStatus('chk_testpaymentid12345678901234');

    expect(mockGatewayPlugin.getPaymentStatus).not.toHaveBeenCalled();
  });

  it('does NOT re-poll gateway for fresh non-terminal status (within 10s)', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING,
      updatedAt: new Date(Date.now() - 5_000).toISOString(), // 5s ago — fresh
    });

    await getPaymentStatus('chk_testpaymentid12345678901234');

    expect(mockGatewayPlugin.getPaymentStatus).not.toHaveBeenCalled();
  });

  it('re-polls gateway for stale non-terminal status (older than 10s)', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING,
      updatedAt: new Date(Date.now() - 15_000).toISOString(), // 15s ago — stale
    });

    await getPaymentStatus('chk_testpaymentid12345678901234');

    expect(mockGatewayPlugin.getPaymentStatus).toHaveBeenCalledOnce();
  });

  it('does NOT update Redis when re-poll returns SUCCESS (blocked)', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING,
      gatewayPaymentId: '', // Empty - waiting for webhook
      updatedAt: new Date(Date.now() - 15_000).toISOString(),
    });

    mockGatewayPlugin.getPaymentStatus.mockResolvedValueOnce({
      gatewayId: 'order_mock001',
      status: PaymentStatus.SUCCESS,
      amount: 50000,
      currency: 'INR',
    });

    await getPaymentStatus('chk_testpaymentid12345678901234');

    // ✅ SUCCESS is blocked - updatePaymentStatus should NOT be called
    expect(updatePaymentStatus).not.toHaveBeenCalled();
  });

  it('updates Redis when re-poll returns PROCESSING status', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING,
      updatedAt: new Date(Date.now() - 15_000).toISOString(),
    });

    mockGatewayPlugin.getPaymentStatus.mockResolvedValueOnce({
      gatewayId: 'order_mock001',
      status: PaymentStatus.PROCESSING,
      amount: 50000,
      currency: 'INR',
    });

    await getPaymentStatus('chk_testpaymentid12345678901234');

    expect(updatePaymentStatus).toHaveBeenCalledWith(
      'chk_testpaymentid12345678901234',
      PaymentStatus.PROCESSING,
    );
  });

  it('updates Redis when re-poll returns FAILED status', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING,
      updatedAt: new Date(Date.now() - 15_000).toISOString(),
    });

    mockGatewayPlugin.getPaymentStatus.mockResolvedValueOnce({
      gatewayId: 'order_mock001',
      status: PaymentStatus.FAILED,
      amount: 50000,
      currency: 'INR',
    });

    await getPaymentStatus('chk_testpaymentid12345678901234');

    expect(updatePaymentStatus).toHaveBeenCalledWith(
      'chk_testpaymentid12345678901234',
      PaymentStatus.FAILED,
    );
  });

  it('does NOT update Redis when re-poll returns the same status', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING,
      updatedAt: new Date(Date.now() - 15_000).toISOString(),
    });

    mockGatewayPlugin.getPaymentStatus.mockResolvedValueOnce({
      gatewayId: 'order_mock001',
      status: PaymentStatus.PENDING, // same status
      amount: 50000,
      currency: 'INR',
    });

    await getPaymentStatus('chk_testpaymentid12345678901234');

    expect(updatePaymentStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// validateAndPrepareRefund — pre-flight validation
// ---------------------------------------------------------------------------

describe('validateAndPrepareRefund', () => {
  it('throws PaymentNotFoundError when payment not in Redis', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce(null);

    await expect(validateAndPrepareRefund('chk_notexist', {})).rejects.toThrow(
      PaymentNotFoundError,
    );
  });

  it('throws RefundNotAllowedError when payment status is PENDING', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING,
    });

    await expect(validateAndPrepareRefund('chk_test', {})).rejects.toThrow(RefundNotAllowedError);
  });

  it('throws RefundNotAllowedError when payment status is FAILED', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.FAILED,
    });

    await expect(validateAndPrepareRefund('chk_test', {})).rejects.toThrow(RefundNotAllowedError);
  });

  it('throws RefundNotAllowedError when gatewayPaymentId is empty', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.SUCCESS,
      gatewayPaymentId: '', // webhook not yet received
    });

    await expect(validateAndPrepareRefund('chk_test', {})).rejects.toThrow(RefundNotAllowedError);
  });

  it('allows refund on SUCCESS status', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.SUCCESS,
    });
    vi.mocked(findRefundsByChkId).mockResolvedValueOnce([]);

    await expect(validateAndPrepareRefund('chk_test', {})).resolves.not.toThrow();
  });

  it('allows refund on PARTIALLY_REFUNDED status', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PARTIALLY_REFUNDED,
    });
    vi.mocked(findRefundsByChkId).mockResolvedValueOnce([]);

    await expect(validateAndPrepareRefund('chk_test', { amount: 10000 })).resolves.not.toThrow();
  });

  it('defaults to full refund when amount is not provided', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.SUCCESS,
      amount: 50000,
    });
    vi.mocked(findRefundsByChkId).mockResolvedValueOnce([]);

    const result = await validateAndPrepareRefund('chk_test', {});
    expect(result.refundAmount).toBe(50000);
  });

  it('uses provided amount for partial refund', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.SUCCESS,
    });
    vi.mocked(findRefundsByChkId).mockResolvedValueOnce([]);

    const result = await validateAndPrepareRefund('chk_test', { amount: 25000 });
    expect(result.refundAmount).toBe(25000);
  });

  it('throws RefundAmountExceedsPaymentError when refund exceeds remaining', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PARTIALLY_REFUNDED,
      amount: 50000,
    });

    // Already refunded 30000 — only 20000 remaining
    const existingRefund: StoreRefund = {
      refId: 'ref_existing',
      chkId: 'chk_test',
      gatewayRefundId: 'rfnd_existing',
      gateway: 'razorpay',
      amount: 30000,
      currency: 'INR',
      status: RefundStatus.SUCCESS,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(findRefundsByChkId).mockResolvedValueOnce([existingRefund]);

    await expect(validateAndPrepareRefund('chk_test', { amount: 25000 })).rejects.toThrow(
      RefundAmountExceedsPaymentError,
    );
  });

  it('allows exact remaining refund amount', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PARTIALLY_REFUNDED,
      amount: 50000,
    });

    const existingRefund: StoreRefund = {
      refId: 'ref_existing',
      chkId: 'chk_test',
      gatewayRefundId: 'rfnd_existing',
      gateway: 'razorpay',
      amount: 30000,
      currency: 'INR',
      status: RefundStatus.SUCCESS,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(findRefundsByChkId).mockResolvedValueOnce([existingRefund]);

    // Exactly 20000 remaining — should not throw
    await expect(validateAndPrepareRefund('chk_test', { amount: 20000 })).resolves.not.toThrow();
  });
});
