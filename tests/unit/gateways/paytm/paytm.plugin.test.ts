// tests/unit/gateways/paytm/paytm.plugin.test.ts
// Tests for PaytmPlugin — all 7 GatewayPlugin methods.
//
// Business invariants protected:
//   - createPayment throws PaytmPhoneRequiredError when customerPhone is missing
//   - createRefund detects settlement delay and throws RefundNotReadyError
//   - parseWebhookEvent rejects invalid/missing CHECKSUMHASH with GatewayInvalidSignatureError
//   - parseWebhookEvent rejects missing TXNID or STATUS with GatewayMappingError
//   - parseWebhookEvent populates gatewayOrderId from ORDERID for fallback lookup
//   - getRefundStatus always throws GatewayUnavailableError (Paytm doesn't support polling)
//   - getCheckoutAction returns { type: 'redirect', url }
//   - healthCheck treats 4xx responses as healthy; only network errors = unhealthy

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as PaytmChecksum from 'paytmchecksum';
import { PaytmPlugin, type PaytmConfig } from '../../../../src/gateways/paytm/paytm.plugin';
import {
  GatewayTimeoutError,
  GatewayUnavailableError,
  GatewayInvalidSignatureError,
  GatewayMappingError,
  RefundNotReadyError,
} from '../../../../src/errors';
import { PaytmPhoneRequiredError } from '../../../../src/errors/paytm.errors';
import { PaymentCreationFailedError } from '../../../../src/errors/payment.errors';
import { PaymentStatus } from '../../../../src/types/payment.types';
import type { StoredPayment } from '../../../../src/types/payment.types';

// ---------------------------------------------------------------------------
// Mock paytmchecksum — prevents real crypto in unit tests
// ---------------------------------------------------------------------------

vi.mock('paytmchecksum', () => ({
  generateSignature: vi.fn().mockReturnValue('mock-checksum-signature'),
  verifySignature: vi.fn().mockReturnValue(true),
  generateRefundChecksum: vi.fn().mockReturnValue('mock-refund-checksum'),
}));

// ---------------------------------------------------------------------------
// Mock axios — intercepts all HTTP calls made by the plugin
// ---------------------------------------------------------------------------

const { mockAxiosPost } = vi.hoisted(() => ({
  mockAxiosPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn().mockReturnValue({
      post: mockAxiosPost,
      defaults: { baseURL: 'https://securegw.paytm.in' },
    }),
    isAxiosError: vi.fn(
      (err: unknown) => (err as { isAxiosError?: boolean })?.isAxiosError === true,
    ),
  },
}));

// ---------------------------------------------------------------------------
// Test config and plugin instance
// ---------------------------------------------------------------------------

const TEST_CONFIG: PaytmConfig = {
  credentials: {
    merchantId: 'test_mid_001',
    merchantKey: 'test_merchant_key_001',
    webhookSecret: 'test_webhook_secret_001',
  },
  baseUrl: 'https://securegw.paytm.in',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validCreatePaymentParams = {
  orderId: 'ORDER_001',
  amount: 50000,
  currency: 'INR' as const,
  customerPhone: '9876543210',
  customerName: 'Test User',
  customerEmail: 'test@example.com',
};

const successCreatePaymentResponse = {
  status: 200,
  data: {
    head: {},
    body: {
      resultInfo: { resultStatus: 'S', resultCode: '00', resultMsg: 'Success' },
      txnToken: 'test_txn_token_001',
      orderId: 'ORDER_001',
      paymentUrl:
        'https://securegw.paytm.in/theia/api/v1/showPaymentPage?mid=test_mid_001&orderId=ORDER_001',
    },
  },
};

const successTransactionStatusResponse = {
  status: 200,
  data: {
    head: {},
    body: {
      txnId: 'TXNID_001',
      orderId: 'ORDER_001',
      txnAmount: '500.00',
      currency: 'INR',
      status: 'TXN_SUCCESS',
      respCode: '01',
      respMsg: 'Txn Success',
      resultInfo: { resultStatus: 'S', resultCode: '01', resultMsg: 'Success' },
    },
  },
};

const successRefundResponse = {
  status: 200,
  data: {
    head: {},
    body: {
      refundId: 'REFUND_001',
      txnId: 'TXNID_001',
      orderId: 'ORDER_001',
      refundAmount: '500.00',
      currency: 'INR',
      status: 'SUCCESS',
      resultInfo: { resultStatus: 'S', resultCode: '01', resultMsg: 'Success' },
    },
  },
};

const mockStoredPayment: StoredPayment = {
  chkId: 'chk_testpaymentid12345678901234',
  gatewayOrderId: 'ORDER_001',
  gatewayPaymentId: 'TXNID_001',
  gateway: 'paytm',
  orderId: 'dev_order_001',
  amount: 50000,
  currency: 'INR',
  status: PaymentStatus.PENDING,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let plugin: PaytmPlugin;

beforeEach(() => {
  vi.clearAllMocks();
  plugin = new PaytmPlugin(TEST_CONFIG);
});

// ===========================================================================
// createPayment
// ===========================================================================

describe('PaytmPlugin.createPayment', () => {
  it('throws PaytmPhoneRequiredError when customerPhone is missing', async () => {
    await expect(
      plugin.createPayment({ ...validCreatePaymentParams, customerPhone: undefined }),
    ).rejects.toThrow(PaytmPhoneRequiredError);
  });

  it('throws PaytmPhoneRequiredError when customerPhone is an empty string', async () => {
    await expect(
      plugin.createPayment({ ...validCreatePaymentParams, customerPhone: '' }),
    ).rejects.toThrow(PaytmPhoneRequiredError);
  });

  it('throws PaytmPhoneRequiredError when customerPhone is whitespace only', async () => {
    await expect(
      plugin.createPayment({ ...validCreatePaymentParams, customerPhone: '   ' }),
    ).rejects.toThrow(PaytmPhoneRequiredError);
  });

  it('returns GatewayPaymentResult with paymentUrl on success', async () => {
    mockAxiosPost.mockResolvedValueOnce(successCreatePaymentResponse);

    const result = await plugin.createPayment(validCreatePaymentParams);

    expect(result.gatewayId).toBe('ORDER_001');
    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.amount).toBe(50000);
    expect(result.currency).toBe('INR');
    expect(result.paymentUrl).toBeDefined();
    expect(result.paymentUrl).toContain('ORDER_001');
  });

  it('returns PENDING status regardless of gateway response', async () => {
    mockAxiosPost.mockResolvedValueOnce(successCreatePaymentResponse);

    const result = await plugin.createPayment(validCreatePaymentParams);

    expect(result.status).toBe(PaymentStatus.PENDING);
  });

  it('throws PaymentCreationFailedError when resultStatus is not S', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      status: 200,
      data: {
        head: {},
        body: {
          resultInfo: { resultStatus: 'F', resultCode: '330', resultMsg: 'Order already exists' },
          txnToken: '',
          orderId: 'ORDER_001',
        },
      },
    });

    await expect(plugin.createPayment(validCreatePaymentParams)).rejects.toThrow(
      PaymentCreationFailedError,
    );
  });

  it('throws GatewayTimeoutError when request times out', async () => {
    const timeoutError = Object.assign(new Error('timeout'), {
      isAxiosError: true,
      code: 'ECONNABORTED',
    });
    mockAxiosPost.mockRejectedValueOnce(timeoutError);

    const axios = await import('axios');
    vi.mocked(axios.default.isAxiosError).mockReturnValueOnce(true);

    await expect(plugin.createPayment(validCreatePaymentParams)).rejects.toThrow(
      GatewayTimeoutError,
    );
  });

  it('does not include customerEmail in request body when undefined', async () => {
    mockAxiosPost.mockResolvedValueOnce(successCreatePaymentResponse);

    await plugin.createPayment({
      ...validCreatePaymentParams,
      customerEmail: undefined,
    });

    const callArg = mockAxiosPost.mock.calls[0]?.[1] as {
      body?: { userInfo?: { email?: string } };
    };
    expect(callArg?.body?.userInfo?.email).toBeUndefined();
  });
});

// ===========================================================================
// getPaymentStatus
// ===========================================================================

describe('PaytmPlugin.getPaymentStatus', () => {
  it('returns GatewayPaymentResult with correct status for TXN_SUCCESS', async () => {
    mockAxiosPost.mockResolvedValueOnce(successTransactionStatusResponse);

    const result = await plugin.getPaymentStatus('ORDER_001');

    expect(result.status).toBe(PaymentStatus.SUCCESS);
    expect(result.gatewayId).toBe('TXNID_001');
    expect(result.amount).toBe(50000);
  });

  it('returns FAILED status for TXN_FAILURE', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      status: 200,
      data: {
        head: {},
        body: {
          txnId: 'TXNID_001',
          orderId: 'ORDER_001',
          txnAmount: '500.00',
          currency: 'INR',
          status: 'TXN_FAILURE',
          respCode: '227',
          respMsg: 'Declined',
          resultInfo: { resultStatus: 'F', resultCode: '227', resultMsg: 'Declined' },
        },
      },
    });

    const result = await plugin.getPaymentStatus('ORDER_001');

    expect(result.status).toBe(PaymentStatus.FAILED);
  });

  it('throws GatewayTimeoutError on timeout', async () => {
    const timeoutError = Object.assign(new Error('timeout'), {
      isAxiosError: true,
      code: 'ECONNABORTED',
    });
    mockAxiosPost.mockRejectedValueOnce(timeoutError);

    const axios = await import('axios');
    vi.mocked(axios.default.isAxiosError).mockReturnValueOnce(true);

    await expect(plugin.getPaymentStatus('ORDER_001')).rejects.toThrow(GatewayTimeoutError);
  });
});

// ===========================================================================
// createRefund
// ===========================================================================

describe('PaytmPlugin.createRefund', () => {
  const refundParams = {
    gatewayPaymentId: 'TXNID_001',
    amount: 50000,
    reason: 'customer request',
  };

  it('returns GatewayRefundResult on success', async () => {
    mockAxiosPost.mockResolvedValueOnce(successRefundResponse);

    const result = await plugin.createRefund(refundParams);

    expect(result.gatewayRefundId).toBe('REFUND_001');
    expect(result.gatewayPaymentId).toBe('TXNID_001');
    expect(result.amount).toBe(50000);
  });

  it('throws RefundNotReadyError when resultCode is 501 (settlement delay)', async () => {
    const settlementError = Object.assign(new Error('Settlement pending'), {
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          body: {
            resultInfo: {
              resultStatus: 'F',
              resultCode: '501',
              resultMsg: 'Payment not settled yet',
            },
          },
        },
      },
    });
    mockAxiosPost.mockRejectedValueOnce(settlementError);

    const axios = await import('axios');
    vi.mocked(axios.default.isAxiosError).mockReturnValueOnce(true);

    await expect(plugin.createRefund(refundParams)).rejects.toThrow(RefundNotReadyError);
  });

  it('throws RefundNotReadyError when resultMsg contains "not settled"', async () => {
    const settlementError = Object.assign(new Error('Not settled'), {
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          body: {
            resultInfo: {
              resultStatus: 'F',
              resultCode: '400',
              resultMsg: 'Transaction not settled, try later',
            },
          },
        },
      },
    });
    mockAxiosPost.mockRejectedValueOnce(settlementError);

    const axios = await import('axios');
    vi.mocked(axios.default.isAxiosError).mockReturnValueOnce(true);

    await expect(plugin.createRefund(refundParams)).rejects.toThrow(RefundNotReadyError);
  });

  it('throws GatewayTimeoutError on timeout', async () => {
    const timeoutError = Object.assign(new Error('timeout'), {
      isAxiosError: true,
      code: 'ECONNABORTED',
    });
    mockAxiosPost.mockRejectedValueOnce(timeoutError);

    const axios = await import('axios');
    vi.mocked(axios.default.isAxiosError).mockReturnValueOnce(true);

    await expect(plugin.createRefund(refundParams)).rejects.toThrow(GatewayTimeoutError);
  });
});

// ===========================================================================
// getRefundStatus
// ===========================================================================

describe('PaytmPlugin.getRefundStatus', () => {
  it('always throws GatewayUnavailableError — Paytm does not support refund status polling', async () => {
    await expect(plugin.getRefundStatus('REFUND_001')).rejects.toThrow(GatewayUnavailableError);
  });

  it('error message explains that refund status comes via webhooks only', async () => {
    try {
      await plugin.getRefundStatus('REFUND_001');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayUnavailableError);
      expect((err as GatewayUnavailableError).message).toContain('webhook');
    }
  });
});

// ===========================================================================
// parseWebhookEvent
// ===========================================================================

describe('PaytmPlugin.parseWebhookEvent', () => {
  const validPayload = {
    MID: 'test_mid_001',
    ORDERID: 'ORDER_001',
    TXNID: 'TXNID_001',
    TXNAMOUNT: '500.00',
    CURRENCY: 'INR',
    STATUS: 'TXN_SUCCESS',
    RESPCODE: '01',
    RESPMSG: 'Txn Successful',
    CHECKSUMHASH: 'valid-checksum-hash',
  };

  it('returns WebhookEvent for valid payload with correct signature', () => {
    // paytmchecksum.verifySignature is mocked to return true
    const event = plugin.parseWebhookEvent(validPayload, {});

    expect(event.gateway).toBe('paytm');
    expect(event.gatewayPaymentId).toBe('TXNID_001');
    expect(event.status).toBe(PaymentStatus.SUCCESS);
    expect(event.amount).toBe(50000); // "500.00" → 50000 paise
    expect(event.currency).toBe('INR');
    expect(event.event).toBe('TXN_SUCCESS');
  });

  it('populates gatewayOrderId from ORDERID for fallback lookup', () => {
    const event = plugin.parseWebhookEvent(validPayload, {});

    expect(event.gatewayOrderId).toBe('ORDER_001');
  });

  it('throws GatewayInvalidSignatureError when CHECKSUMHASH is missing', () => {
    const { CHECKSUMHASH: _, ...payloadWithoutChecksum } = validPayload;

    expect(() => plugin.parseWebhookEvent(payloadWithoutChecksum, {})).toThrow(
      GatewayInvalidSignatureError,
    );
  });

  it('throws GatewayInvalidSignatureError when checksum verification fails', () => {
    vi.mocked(PaytmChecksum.verifySignature).mockReturnValueOnce(false);

    expect(() => plugin.parseWebhookEvent(validPayload, {})).toThrow(GatewayInvalidSignatureError);
  });

  it('throws GatewayMappingError when TXNID is missing', () => {
    const { TXNID: _, ...payloadWithoutTxnId } = validPayload;

    expect(() => plugin.parseWebhookEvent(payloadWithoutTxnId, {})).toThrow(GatewayMappingError);
  });

  it('throws GatewayMappingError when STATUS is missing', () => {
    const { STATUS: _, ...payloadWithoutStatus } = validPayload;

    expect(() => plugin.parseWebhookEvent(payloadWithoutStatus, {})).toThrow(GatewayMappingError);
  });

  it('correctly maps TXN_FAILURE status', () => {
    const event = plugin.parseWebhookEvent(
      { ...validPayload, STATUS: 'TXN_FAILURE', RESPCODE: '227' },
      {},
    );

    expect(event.status).toBe(PaymentStatus.FAILED);
  });

  it('correctly maps PENDING + RESPCODE 503 to CANCELLED', () => {
    const event = plugin.parseWebhookEvent(
      { ...validPayload, STATUS: 'PENDING', RESPCODE: '503' },
      {},
    );

    expect(event.status).toBe(PaymentStatus.CANCELLED);
  });

  it('correctly maps PENDING + RESPCODE 501 to EXPIRED', () => {
    const event = plugin.parseWebhookEvent(
      { ...validPayload, STATUS: 'PENDING', RESPCODE: '501' },
      {},
    );

    expect(event.status).toBe(PaymentStatus.EXPIRED);
  });

  it('preserves raw body in the event', () => {
    const event = plugin.parseWebhookEvent(validPayload, {});

    expect(event.raw).toBe(validPayload);
  });
});

// ===========================================================================
// getCheckoutAction
// ===========================================================================

describe('PaytmPlugin.getCheckoutAction', () => {
  it('returns action with type redirect', () => {
    const action = plugin.getCheckoutAction(mockStoredPayment);

    expect(action.type).toBe('redirect');
  });

  it('returns a URL containing the merchant ID and order ID', () => {
    const action = plugin.getCheckoutAction(mockStoredPayment);

    expect(action.url).toBeDefined();
    expect(action.url).toContain('ORDER_001');
    expect(action.url).toContain('test_mid_001');
  });

  it('URL points to the Paytm payment page path', () => {
    const action = plugin.getCheckoutAction(mockStoredPayment);

    expect(action.url).toContain('showPaymentPage');
  });
});

// ===========================================================================
// healthCheck
// ===========================================================================

describe('PaytmPlugin.healthCheck', () => {
  it('returns healthy: true when Paytm API responds (even with 4xx)', async () => {
    // Paytm returns 4xx for dummy order IDs — that is treated as healthy
    mockAxiosPost.mockResolvedValueOnce({ status: 404, data: {} });

    const result = await plugin.healthCheck();

    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns healthy: true for any non-network response', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: {} });

    const result = await plugin.healthCheck();

    expect(result.healthy).toBe(true);
  });

  it('returns healthy: false on network error (ECONNREFUSED)', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await plugin.healthCheck();

    expect(result.healthy).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('includes latencyMs in the result', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: {} });

    const result = await plugin.healthCheck();

    expect(typeof result.latencyMs).toBe('number');
  });
});
