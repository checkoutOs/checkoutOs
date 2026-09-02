// tests/unit/services/payment.service.idempotency.test.ts
// Tests for createPaymentWithIdempotency() orchestration.
//
// Business invariants protected:
//   - A HIT short-circuits before any orderId lookup or gateway call
//   - A fresh IN_PROGRESS record surfaces as IdempotencyRequestInProgressError
//   - The orderId-dedup path completes the idempotency record (regression:
//     an early return here stranded the record as IN_PROGRESS, so the key
//     could never be replayed as a HIT)
//   - The create path still completes the record
//   - completeIdempotency() failure never breaks the payment response

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentStatus } from '../../../src/types/payment.types';
import type { StoredPayment } from '../../../src/types/payment.types';
import { IdempotencyRequestInProgressError, OrderIdAmountMismatchError } from '../../../src/errors';

// ---------------------------------------------------------------------------
// Mock all external dependencies
// ---------------------------------------------------------------------------

vi.mock('../../../src/store/payment.store', () => ({
  savePayment: vi.fn().mockResolvedValue(undefined),
  findPaymentByChkId: vi.fn(),
  findPaymentByOrderId: vi.fn(),
  updatePaymentStatus: vi.fn().mockResolvedValue(undefined),
  updateGatewayPaymentId: vi.fn().mockResolvedValue(undefined),
  findChkIdByGatewayId: vi.fn(),
}));

vi.mock('../../../src/store/refund.store', () => ({
  findRefundsByChkId: vi.fn().mockResolvedValue([]),
  saveRefund: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/idempotency.service', () => ({
  checkIdempotency: vi.fn(),
  completeIdempotency: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/gateways/gateway.registry', () => ({
  getActiveGateway: vi.fn(),
  // Re-export registry constants consumed by config/index.ts at module load
  supportedGateways: ['razorpay', 'payu', 'cashfree', 'paytm'] as const,
  gatewayEnvDefinitions: {
    razorpay: {
      requiredEnvKeys: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
      defaultBaseUrl: 'https://api.razorpay.com/v1',
      baseUrlEnvKey: 'RAZORPAY_BASE_URL',
    },
  },
  gatewayCredentialEnvKeys: {
    razorpay: {
      keyId: 'RAZORPAY_KEY_ID',
      keySecret: 'RAZORPAY_KEY_SECRET',
      webhookSecret: 'RAZORPAY_WEBHOOK_SECRET',
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
  generatePaymentId: vi.fn().mockReturnValue('chk_freshpaymentid1234567890123'),
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import { createPaymentWithIdempotency } from '../../../src/services/payments.service';
import { findPaymentByOrderId } from '../../../src/store/payment.store';
import { checkIdempotency, completeIdempotency } from '../../../src/services/idempotency.service';
import { getActiveGateway } from '../../../src/gateways/gateway.registry';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDEMPOTENCY = {
  key: '3f7d2a1e-1c4b-4f8a-9d2e-000000000001',
  requestHash: 'sha256-request-hash',
};

const REQUEST = {
  orderId: 'order_dedup_1',
  amount: 50000,
  currency: 'INR' as const,
};

// A payment already created for REQUEST.orderId by an earlier request.
const EXISTING_PAYMENT: StoredPayment = {
  chkId: 'chk_existingpayment123456789012',
  gatewayOrderId: 'order_RzPExisting01',
  gatewayPaymentId: '',
  gateway: 'razorpay',
  orderId: REQUEST.orderId,
  amount: REQUEST.amount,
  currency: 'INR',
  status: PaymentStatus.PENDING,
  createdAt: '2026-04-14T10:00:00.000Z',
  updatedAt: '2026-04-14T10:00:00.000Z',
};

function mockGatewayCreate(): void {
  vi.mocked(getActiveGateway).mockReturnValue({
    createPayment: vi.fn().mockResolvedValue({
      gatewayId: 'order_RzPFresh01',
      gatewayOrderId: 'order_RzPFresh01',
      status: PaymentStatus.PENDING,
      amount: REQUEST.amount,
      currency: 'INR',
    }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(completeIdempotency).mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Idempotency short-circuits
// ---------------------------------------------------------------------------

describe('createPaymentWithIdempotency — idempotency check', () => {
  it('returns the cached response on HIT without touching the store or gateway', async () => {
    const cached = { paymentId: 'chk_cached00000000000000000000', amount: 50000 };
    vi.mocked(checkIdempotency).mockResolvedValue({ type: 'HIT', response: cached });

    const result = await createPaymentWithIdempotency(REQUEST, IDEMPOTENCY);

    expect(result).toBe(cached);
    expect(findPaymentByOrderId).not.toHaveBeenCalled();
    expect(getActiveGateway).not.toHaveBeenCalled();
  });

  it('throws IdempotencyRequestInProgressError when a request is already running', async () => {
    vi.mocked(checkIdempotency).mockResolvedValue({ type: 'IN_PROGRESS' });

    await expect(createPaymentWithIdempotency(REQUEST, IDEMPOTENCY)).rejects.toThrow(
      IdempotencyRequestInProgressError,
    );
    expect(findPaymentByOrderId).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// orderId dedup path — regression coverage
// ---------------------------------------------------------------------------

describe('createPaymentWithIdempotency — orderId dedup path', () => {
  beforeEach(() => {
    vi.mocked(checkIdempotency).mockResolvedValue({ type: 'MISS' });
    vi.mocked(findPaymentByOrderId).mockResolvedValue(EXISTING_PAYMENT);
  });

  it('completes the idempotency record so the key can later replay as a HIT', async () => {
    const result = await createPaymentWithIdempotency(REQUEST, IDEMPOTENCY);

    // The deduped payment is returned...
    expect(result.paymentId).toBe(EXISTING_PAYMENT.chkId);
    // ...and the IN_PROGRESS record created by checkIdempotency() is closed out.
    // Without this the record stays IN_PROGRESS: the same key replayed inside
    // the 30s stale window returns 409, and never becomes a HIT.
    expect(completeIdempotency).toHaveBeenCalledTimes(1);
    expect(completeIdempotency).toHaveBeenCalledWith({
      key: IDEMPOTENCY.key,
      requestHash: IDEMPOTENCY.requestHash,
      response: result,
    });
  });

  it('caches the deduped payment identity, not a newly generated one', async () => {
    await createPaymentWithIdempotency(REQUEST, IDEMPOTENCY);

    const cachedResponse = vi.mocked(completeIdempotency).mock.calls[0]?.[0].response as {
      paymentId: string;
    };
    expect(cachedResponse.paymentId).toBe(EXISTING_PAYMENT.chkId);
  });

  it('does not call the gateway when deduping', async () => {
    await createPaymentWithIdempotency(REQUEST, IDEMPOTENCY);

    expect(getActiveGateway).not.toHaveBeenCalled();
  });

  it('still dedups without an idempotency key and completes nothing', async () => {
    const result = await createPaymentWithIdempotency(REQUEST);

    expect(result.paymentId).toBe(EXISTING_PAYMENT.chkId);
    expect(checkIdempotency).not.toHaveBeenCalled();
    expect(completeIdempotency).not.toHaveBeenCalled();
  });

  it('does not complete the record when the orderId collides with a different amount', async () => {
    await expect(
      createPaymentWithIdempotency({ ...REQUEST, amount: 100000 }, IDEMPOTENCY),
    ).rejects.toThrow(OrderIdAmountMismatchError);

    expect(completeIdempotency).not.toHaveBeenCalled();
  });

  it('returns the payment even when completeIdempotency() fails', async () => {
    vi.mocked(completeIdempotency).mockResolvedValue(false);

    const result = await createPaymentWithIdempotency(REQUEST, IDEMPOTENCY);

    expect(result.paymentId).toBe(EXISTING_PAYMENT.chkId);
  });
});

// ---------------------------------------------------------------------------
// create path — unchanged behaviour
// ---------------------------------------------------------------------------

describe('createPaymentWithIdempotency — create path', () => {
  beforeEach(() => {
    vi.mocked(checkIdempotency).mockResolvedValue({ type: 'MISS' });
    vi.mocked(findPaymentByOrderId).mockResolvedValue(null);
    mockGatewayCreate();
  });

  it('creates a new payment and completes the idempotency record', async () => {
    const result = await createPaymentWithIdempotency(REQUEST, IDEMPOTENCY);

    expect(result.paymentId).toBe('chk_freshpaymentid1234567890123');
    expect(completeIdempotency).toHaveBeenCalledTimes(1);
    expect(completeIdempotency).toHaveBeenCalledWith({
      key: IDEMPOTENCY.key,
      requestHash: IDEMPOTENCY.requestHash,
      response: result,
    });
  });

  it('returns the payment even when completeIdempotency() fails', async () => {
    vi.mocked(completeIdempotency).mockResolvedValue(false);

    const result = await createPaymentWithIdempotency(REQUEST, IDEMPOTENCY);

    expect(result.paymentId).toBe('chk_freshpaymentid1234567890123');
  });
});
