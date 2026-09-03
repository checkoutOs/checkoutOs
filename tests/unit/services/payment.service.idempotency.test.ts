// tests/unit/services/payment.service.idempotency.test.ts
// Tests for createPaymentWithIdempotency() orchestration.
//
// Business invariants protected:
//   - Validation runs BEFORE the key is claimed, so a rejected payload never
//     strands a key that the corrected retry would then be refused for
//   - A HIT short-circuits before any orderId lookup or gateway call
//   - A fresh IN_PROGRESS record surfaces as IdempotencyRequestInProgressError
//   - The orderId-dedup path completes the idempotency record (regression:
//     an early return here stranded the record as IN_PROGRESS, so the key
//     could never be replayed as a HIT)
//   - The create path still completes the record
//   - completeIdempotency() failure never breaks the payment response
//   - Pre-gateway rejections release the claim; anything from the gateway call
//     onward HOLDS it, because an order may exist and a released key would let
//     the retry create a second one

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentStatus } from '../../../src/types/payment.types';
import type { StoredPayment } from '../../../src/types/payment.types';
import {
  IdempotencyRequestInProgressError,
  InvalidAmountError,
  InvalidOrderIdError,
  OrderIdAmountMismatchError,
  OrderIdCurrencyMismatchError,
  OrderCreationInProgressError,
} from '../../../src/errors';

// ---------------------------------------------------------------------------
// Mock all external dependencies
// ---------------------------------------------------------------------------

vi.mock('../../../src/store/payment.store', () => ({
  savePayment: vi.fn().mockResolvedValue(undefined),
  findPaymentByChkId: vi.fn(),
  findPaymentByOrderId: vi.fn(),
  reserveOrderId: vi.fn(),
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
  releaseIdempotency: vi.fn().mockResolvedValue(true),
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
import {
  findPaymentByOrderId,
  reserveOrderId,
  savePayment,
} from '../../../src/store/payment.store';
import {
  checkIdempotency,
  completeIdempotency,
  releaseIdempotency,
} from '../../../src/services/idempotency.service';
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
  vi.mocked(releaseIdempotency).mockResolvedValue(true);
  vi.mocked(reserveOrderId).mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Validation runs before the key is claimed
// ---------------------------------------------------------------------------

describe('createPaymentWithIdempotency — validation ordering', () => {
  it('rejects an invalid amount without ever claiming the idempotency key', async () => {
    await expect(
      createPaymentWithIdempotency({ ...REQUEST, amount: -1 }, IDEMPOTENCY),
    ).rejects.toThrow(InvalidAmountError);

    // checkIdempotency() writes an IN_PROGRESS record as the side effect of a
    // MISS. Validating first means a rejected payload never takes the key —
    // so the corrected retry is not refused as IDEMPOTENCY_KEY_REUSED.
    expect(checkIdempotency).not.toHaveBeenCalled();
    // Nothing was claimed, so there is nothing to release.
    expect(releaseIdempotency).not.toHaveBeenCalled();
  });

  it.each([0, -100, 1.5, Number.NaN])('rejects amount %s before claiming', async (amount) => {
    await expect(createPaymentWithIdempotency({ ...REQUEST, amount }, IDEMPOTENCY)).rejects.toThrow(
      InvalidAmountError,
    );

    expect(checkIdempotency).not.toHaveBeenCalled();
  });

  // orderId reaches Redis as part of chk:pay:by-order:{orderId} and is rendered
  // into the checkout page, so it is rejected before it can do either.
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['non-string', 12345],
    ['over 64 chars', 'o'.repeat(65)],
    ['containing a colon (key separator)', 'order:123'],
    ['containing whitespace', 'order 123'],
    ['containing a newline', 'order\n123'],
    ['containing angle brackets', '<script>'],
  ])('rejects an orderId that is %s', async (_label, orderId) => {
    await expect(
      createPaymentWithIdempotency({ ...REQUEST, orderId } as never, IDEMPOTENCY),
    ).rejects.toThrow(InvalidOrderIdError);

    // Never reaches Redis: no key is claimed and no reservation is attempted.
    expect(checkIdempotency).not.toHaveBeenCalled();
    expect(reserveOrderId).not.toHaveBeenCalled();
  });

  it.each(['order_abc123', 'ORDER-001', 'inv.2026.0001', 'o'.repeat(64)])(
    'accepts the merchant-style orderId %s',
    async (orderId) => {
      vi.mocked(checkIdempotency).mockResolvedValue({ type: 'MISS' });
      mockGatewayCreate();

      await expect(
        createPaymentWithIdempotency({ ...REQUEST, orderId }, IDEMPOTENCY),
      ).resolves.toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// orderId reservation — the concurrency guard
// ---------------------------------------------------------------------------

describe('createPaymentWithIdempotency — orderId reservation', () => {
  beforeEach(() => {
    vi.mocked(checkIdempotency).mockResolvedValue({ type: 'MISS' });
    mockGatewayCreate();
  });

  it('reserves the orderId BEFORE calling the gateway', async () => {
    const invocations: string[] = [];
    vi.mocked(reserveOrderId).mockImplementation(async () => {
      invocations.push('reserve');
      return true;
    });
    vi.mocked(getActiveGateway).mockReturnValue({
      createPayment: vi.fn().mockImplementation(() => {
        invocations.push('gateway');
        return Promise.resolve({
          gatewayId: 'order_RzPFresh01',
          gatewayOrderId: 'order_RzPFresh01',
          status: PaymentStatus.PENDING,
          amount: REQUEST.amount,
          currency: 'INR',
        });
      }),
    } as never);

    await createPaymentWithIdempotency(REQUEST, IDEMPOTENCY);

    // Reserving after the gateway call would leave the original race intact.
    expect(invocations).toEqual(['reserve', 'gateway']);
  });

  it('reserves under the same chkId the payment is created with', async () => {
    const result = await createPaymentWithIdempotency(REQUEST, IDEMPOTENCY);

    // savePayment() commits the reservation only if the ids match; a mismatch
    // would write a second, conflicting index entry.
    expect(reserveOrderId).toHaveBeenCalledWith(REQUEST.orderId, result.paymentId);
  });

  it('rejects with 409 when the reservation is held and no payment exists yet', async () => {
    vi.mocked(reserveOrderId).mockResolvedValue(false);
    vi.mocked(findPaymentByOrderId).mockResolvedValue(null);

    await expect(createPaymentWithIdempotency(REQUEST, IDEMPOTENCY)).rejects.toThrow(
      OrderCreationInProgressError,
    );
  });

  it('does NOT call the gateway when it loses the reservation', async () => {
    vi.mocked(reserveOrderId).mockResolvedValue(false);
    vi.mocked(findPaymentByOrderId).mockResolvedValue(null);

    await expect(createPaymentWithIdempotency(REQUEST, IDEMPOTENCY)).rejects.toThrow(
      OrderCreationInProgressError,
    );

    // This is the whole point: the loser must not create a second order.
    expect(getActiveGateway).not.toHaveBeenCalled();
    expect(savePayment).not.toHaveBeenCalled();
  });

  it('releases the idempotency claim before surfacing the 409', async () => {
    vi.mocked(reserveOrderId).mockResolvedValue(false);
    vi.mocked(findPaymentByOrderId).mockResolvedValue(null);

    await expect(createPaymentWithIdempotency(REQUEST, IDEMPOTENCY)).rejects.toThrow(
      OrderCreationInProgressError,
    );

    // No gateway call happened, so handing the key back is provably safe —
    // otherwise the client's key would sit IN_PROGRESS for the stale window
    // after a 409 it can legitimately retry.
    expect(releaseIdempotency).toHaveBeenCalledWith({
      key: IDEMPOTENCY.key,
      requestHash: IDEMPOTENCY.requestHash,
    });
  });

  it('HOLDS the reservation when the gateway call fails', async () => {
    vi.mocked(getActiveGateway).mockReturnValue({
      createPayment: vi.fn().mockRejectedValue(new Error('gateway exploded')),
    } as never);

    await expect(createPaymentWithIdempotency(REQUEST, IDEMPOTENCY)).rejects.toThrow(
      'gateway exploded',
    );

    // An order may exist despite the error. Releasing the orderId would let a
    // retry create the duplicate the reservation exists to prevent; the 30s
    // TTL is the recovery path instead.
    expect(releaseIdempotency).not.toHaveBeenCalled();
  });

  it('still guards the orderId when no idempotency key is supplied', async () => {
    vi.mocked(reserveOrderId).mockResolvedValue(false);
    vi.mocked(findPaymentByOrderId).mockResolvedValue(null);

    // The reservation is independent of the idempotency layer — a client that
    // omits the header is still protected against concurrent duplicates.
    await expect(createPaymentWithIdempotency(REQUEST)).rejects.toThrow(
      OrderCreationInProgressError,
    );
    expect(releaseIdempotency).not.toHaveBeenCalled();
  });
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
    // Reservation lost: the orderId key is already held by a committed payment.
    vi.mocked(reserveOrderId).mockResolvedValue(false);
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

  it('releases rather than completes the claim when the orderId collides on amount', async () => {
    await expect(
      createPaymentWithIdempotency({ ...REQUEST, amount: 100000 }, IDEMPOTENCY),
    ).rejects.toThrow(OrderIdAmountMismatchError);

    // A rejection is never cached under the key...
    expect(completeIdempotency).not.toHaveBeenCalled();
    // ...but the claim is handed back, since no gateway call was made. The
    // client's retry gets the real 409 instead of REQUEST_IN_PROGRESS.
    expect(releaseIdempotency).toHaveBeenCalledWith({
      key: IDEMPOTENCY.key,
      requestHash: IDEMPOTENCY.requestHash,
    });
  });

  it('releases the claim when the orderId collides on currency', async () => {
    await expect(
      createPaymentWithIdempotency({ ...REQUEST, currency: 'USD' as never }, IDEMPOTENCY),
    ).rejects.toThrow(OrderIdCurrencyMismatchError);

    expect(releaseIdempotency).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a release when no idempotency key was supplied', async () => {
    await expect(createPaymentWithIdempotency({ ...REQUEST, amount: 100000 })).rejects.toThrow(
      OrderIdAmountMismatchError,
    );

    expect(releaseIdempotency).not.toHaveBeenCalled();
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
    vi.mocked(reserveOrderId).mockResolvedValue(true);
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

  it('HOLDS the claim when the gateway call fails — releasing could double-charge', async () => {
    vi.mocked(getActiveGateway).mockReturnValue({
      createPayment: vi.fn().mockRejectedValue(new Error('gateway exploded')),
    } as never);

    await expect(createPaymentWithIdempotency(REQUEST, IDEMPOTENCY)).rejects.toThrow(
      'gateway exploded',
    );

    // Once plugin.createPayment() has been invoked an order may exist at the
    // gateway even though the call reported an error. Handing the key back
    // would let the retry create a second order, so the claim is held and the
    // 30s stale window governs recovery instead.
    expect(releaseIdempotency).not.toHaveBeenCalled();
    expect(completeIdempotency).not.toHaveBeenCalled();
  });

  it('HOLDS the claim when persistence fails after a successful gateway call', async () => {
    vi.mocked(savePayment).mockRejectedValueOnce(new Error('redis down'));

    await expect(createPaymentWithIdempotency(REQUEST, IDEMPOTENCY)).rejects.toThrow('redis down');

    // The gateway order exists but was never persisted — the most dangerous
    // moment to hand the key back.
    expect(releaseIdempotency).not.toHaveBeenCalled();
  });
});
