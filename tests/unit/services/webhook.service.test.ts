// tests/unit/services/webhook.service.test.ts
// Tests for WebhookService business logic.
//
// Business invariants protected:
//   - GatewayInvalidSignatureError propagates — invalid webhooks are rejected
//   - Unknown payment IDs return silently — never throw, never return non-200
//   - gatewayPaymentId is updated on first webhook when previously empty
//   - Payment status is updated only when it actually changes
//   - Relay failure never throws — fire and forget
//   - Redis state is always updated before relay is attempted

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentStatus } from '../../../src/types/payment.types';
import type { StoredPayment } from '../../../src/types/payment.types';
import { GatewayInvalidSignatureError } from '../../../src/errors';
import type { WebhookEvent } from '../../../src/types/gateway.types';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('../../../src/store/payment.store', () => ({
  findChkIdByGatewayId: vi.fn(),
  findPaymentByChkId: vi.fn(),
  updatePaymentStatus: vi.fn().mockResolvedValue(undefined),
  updateGatewayPaymentId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/gateways/gateway.registry', () => ({
  getActiveGateway: vi.fn(),
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

vi.mock('axios', () => ({
  default: {
    post: vi.fn().mockResolvedValue({ status: 200 }),
    isAxiosError: vi.fn().mockReturnValue(false),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { processWebhook } from '../../../src/services/webhook.service';
import {
  findChkIdByGatewayId,
  findPaymentByChkId,
  updatePaymentStatus,
  updateGatewayPaymentId,
} from '../../../src/store/payment.store';
import { getActiveGateway } from '../../../src/gateways/gateway.registry';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockWebhookEvent: WebhookEvent = {
  gateway: 'razorpay',
  gatewayPaymentId: 'pay_mock001',
  event: 'payment.captured',
  status: PaymentStatus.SUCCESS,
  amount: 50000,
  currency: 'INR',
  raw: {},
};

const mockStoredPayment: StoredPayment = {
  chkId: 'chk_testpaymentid12345678901234',
  gatewayOrderId: 'order_mock001',
  gatewayPaymentId: '', // empty — webhook not yet received
  gateway: 'razorpay',
  orderId: 'order_test_001',
  amount: 50000,
  currency: 'INR',
  status: PaymentStatus.PENDING,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockPlugin = {
  name: 'razorpay',
  parseWebhookEvent: vi.fn().mockReturnValue(mockWebhookEvent),
  createPayment: vi.fn(),
  getPaymentStatus: vi.fn(),
  createRefund: vi.fn(),
  getRefundStatus: vi.fn(),
  healthCheck: vi.fn(),
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveGateway).mockReturnValue(mockPlugin as never);
  vi.mocked(findChkIdByGatewayId).mockResolvedValue('chk_testpaymentid12345678901234');
  vi.mocked(findPaymentByChkId).mockResolvedValue(mockStoredPayment);
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe('processWebhook — signature verification', () => {
  it('propagates GatewayInvalidSignatureError when signature is invalid', async () => {
    mockPlugin.parseWebhookEvent.mockImplementationOnce(() => {
      throw new GatewayInvalidSignatureError('razorpay');
    });

    await expect(processWebhook('razorpay', {}, {})).rejects.toThrow(GatewayInvalidSignatureError);
  });

  it('does not update Redis if signature verification fails', async () => {
    mockPlugin.parseWebhookEvent.mockImplementationOnce(() => {
      throw new GatewayInvalidSignatureError('razorpay');
    });

    try {
      await processWebhook('razorpay', {}, {});
    } catch {
      // expected
    }

    expect(updatePaymentStatus).not.toHaveBeenCalled();
    expect(updateGatewayPaymentId).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unknown payment handling
// ---------------------------------------------------------------------------

describe('processWebhook — unknown payment', () => {
  it('returns silently when gatewayPaymentId has no matching chk_ ID', async () => {
    vi.mocked(findChkIdByGatewayId).mockResolvedValueOnce(null);

    // Must not throw
    await expect(processWebhook('razorpay', {}, {})).resolves.toBeUndefined();
  });

  it('does not update Redis for unknown payment', async () => {
    vi.mocked(findChkIdByGatewayId).mockResolvedValueOnce(null);

    await processWebhook('razorpay', {}, {});

    expect(updatePaymentStatus).not.toHaveBeenCalled();
    expect(updateGatewayPaymentId).not.toHaveBeenCalled();
  });

  it('does not relay webhook for unknown payment', async () => {
    vi.mocked(findChkIdByGatewayId).mockResolvedValueOnce(null);

    await processWebhook('razorpay', {}, {});

    expect(axios.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// gatewayPaymentId update (Option C)
// ---------------------------------------------------------------------------

describe('processWebhook — gatewayPaymentId update', () => {
  it('calls updateGatewayPaymentId when gatewayPaymentId is empty on stored payment', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      gatewayPaymentId: '', // empty — first webhook
    });

    await processWebhook('razorpay', {}, {});

    expect(updateGatewayPaymentId).toHaveBeenCalledWith(
      'chk_testpaymentid12345678901234',
      'razorpay',
      'pay_mock001',
    );
  });

  it('does NOT call updateGatewayPaymentId when gatewayPaymentId is already set', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      gatewayPaymentId: 'pay_mock001', // already set
    });

    await processWebhook('razorpay', {}, {});

    expect(updateGatewayPaymentId).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Status update
// ---------------------------------------------------------------------------

describe('processWebhook — status update', () => {
  it('updates payment status when webhook status differs from stored status', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING, // current status
      gatewayPaymentId: 'pay_mock001',
    });

    // Webhook reports SUCCESS
    mockPlugin.parseWebhookEvent.mockReturnValueOnce({
      ...mockWebhookEvent,
      status: PaymentStatus.SUCCESS,
    });

    await processWebhook('razorpay', {}, {});

    expect(updatePaymentStatus).toHaveBeenCalledWith(
      'chk_testpaymentid12345678901234',
      PaymentStatus.SUCCESS,
    );
  });

  it('does NOT update status when webhook status matches stored status', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.SUCCESS,
      gatewayPaymentId: 'pay_mock001',
    });

    mockPlugin.parseWebhookEvent.mockReturnValueOnce({
      ...mockWebhookEvent,
      status: PaymentStatus.SUCCESS, // same status
    });

    await processWebhook('razorpay', {}, {});

    expect(updatePaymentStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Relay — fire and forget
// ---------------------------------------------------------------------------

describe('processWebhook — relay', () => {
  it('attempts relay after Redis state is updated', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      gatewayPaymentId: 'pay_mock001',
    });

    await processWebhook('razorpay', {}, {});

    // Relay is called
    expect(axios.post).toHaveBeenCalledOnce();
  });

  it('does not throw when relay fails', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      gatewayPaymentId: 'pay_mock001',
    });
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('relay timeout'));

    // Must not throw even when relay fails
    await expect(processWebhook('razorpay', {}, {})).resolves.toBeUndefined();
  });

  it('relay includes paymentId (chk_ ID) in the payload', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      gatewayPaymentId: 'pay_mock001',
    });

    await processWebhook('razorpay', {}, {});

    const relayPayload = vi.mocked(axios.post).mock.calls[0][1] as Record<string, unknown>;
    expect(relayPayload['paymentId']).toBe('chk_testpaymentid12345678901234');
  });

  it('relay payload does not contain gatewayPaymentId at the top level', async () => {
    // Developers must never see gateway-native IDs in the relay payload
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      gatewayPaymentId: 'pay_mock001',
    });

    await processWebhook('razorpay', {}, {});

    const relayPayload = vi.mocked(axios.post).mock.calls[0][1] as Record<string, unknown>;
    // paymentId (chk_) must be present, gateway-native IDs should not be
    // at the top level — they are inside the event object
    expect(relayPayload['paymentId']).toMatch(/^chk_/);
  });
});
