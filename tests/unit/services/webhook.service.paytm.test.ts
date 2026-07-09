// tests/unit/services/webhook.service.paytm.test.ts
// Paytm-specific tests for WebhookService.
//
// Business invariants protected:
//   - State machine guard blocks invalid transitions (SUCCESS → FAILED, etc.)
//   - State machine guard allows valid transitions (PENDING → SUCCESS, etc.)
//   - gatewayOrderId fallback: when TXNID not in Redis, ORDERID is used for lookup
//   - gatewayPaymentId (TXNID) is backfilled into Redis when first Paytm webhook arrives
//   - GatewayInvalidSignatureError propagates — bad Paytm checksums are rejected
//   - All terminal states (SUCCESS, FAILED, CANCELLED, EXPIRED) block further transitions

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
  supportedGateways: ['razorpay', 'payu', 'cashfree', 'paytm'] as const,
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
    paytm: {
      requiredEnvKeys: ['PAYTM_MERCHANT_ID', 'PAYTM_MERCHANT_KEY'],
      defaultBaseUrl: 'https://securegw.paytm.in',
      baseUrlEnvKey: 'PAYTM_BASE_URL',
    },
    cashfree: {
      requiredEnvKeys: ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY', 'CASHFREE_WEBHOOK_SECRET'],
      defaultBaseUrl: 'https://api.cashfree.com',
      baseUrlEnvKey: 'CASHFREE_BASE_URL',
    },
  },
  gatewayCredentialEnvKeys: {
    paytm: {
      merchantId: 'PAYTM_MERCHANT_ID',
      merchantKey: 'PAYTM_MERCHANT_KEY',
      webhookSecret: 'PAYTM_WEBHOOK_SECRET',
    },
  },
  registerGateways: vi.fn(),
  buildActiveGatewayCredentials: vi.fn().mockReturnValue({
    merchantId: 'test_mid',
    merchantKey: 'test_key',
    webhookSecret: 'test_webhook_secret',
  }),
  isSupportedGatewayName: vi.fn().mockReturnValue(true),
  getGatewayByName: vi.fn().mockReturnValue('paytm'),
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

const CHK_ID = 'chk_paytmtest12345678901234567';
const TXNID = 'TXNID_paytm_001';
const ORDERID = 'ORDER_001';

const mockPaytmWebhookEvent: WebhookEvent = {
  gateway: 'paytm',
  gatewayPaymentId: TXNID,
  gatewayOrderId: ORDERID,
  event: 'TXN_SUCCESS',
  status: PaymentStatus.SUCCESS,
  amount: 50000,
  currency: 'INR',
  raw: {},
};

const mockStoredPayment: StoredPayment = {
  chkId: CHK_ID,
  gatewayOrderId: ORDERID,
  gatewayPaymentId: '', // empty — TXNID not yet set (first webhook)
  gateway: 'paytm',
  orderId: 'dev_order_001',
  amount: 50000,
  currency: 'INR',
  status: PaymentStatus.PENDING,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockPlugin = {
  name: 'paytm',
  parseWebhookEvent: vi.fn().mockReturnValue(mockPaytmWebhookEvent),
  createPayment: vi.fn(),
  getPaymentStatus: vi.fn(),
  createRefund: vi.fn(),
  getRefundStatus: vi.fn(),
  getCheckoutAction: vi.fn(),
  healthCheck: vi.fn(),
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // resetAllMocks clears both call history AND queued once-values — prevents
  // cross-test contamination when tests chain mockResolvedValueOnce calls.
  vi.resetAllMocks();
  vi.mocked(getActiveGateway).mockReturnValue(mockPlugin as never);
  vi.mocked(mockPlugin.parseWebhookEvent).mockReturnValue(mockPaytmWebhookEvent);
  // Default: direct TXNID lookup succeeds (simple state machine guard tests)
  vi.mocked(findChkIdByGatewayId).mockResolvedValue(CHK_ID);
  vi.mocked(findPaymentByChkId).mockResolvedValue(mockStoredPayment);
});

// ---------------------------------------------------------------------------
// gatewayOrderId fallback — Paytm-specific
// ---------------------------------------------------------------------------

describe('processWebhook — Paytm ORDERID fallback', () => {
  it('resolves payment via gatewayOrderId when TXNID is not yet in Redis', async () => {
    // Override default: first call (TXNID lookup) returns null, second (ORDERID) returns chkId
    vi.mocked(findChkIdByGatewayId)
      .mockResolvedValueOnce(null) // TXNID miss
      .mockResolvedValueOnce(CHK_ID); // ORDERID hit

    await processWebhook('paytm', {}, {});

    // Verify both lookups were attempted
    expect(findChkIdByGatewayId).toHaveBeenCalledWith('paytm', TXNID);
    expect(findChkIdByGatewayId).toHaveBeenCalledWith('paytm', ORDERID);
  });

  it('updates payment status after successful ORDERID fallback', async () => {
    vi.mocked(findChkIdByGatewayId).mockResolvedValueOnce(null).mockResolvedValueOnce(CHK_ID);

    await processWebhook('paytm', {}, {});

    expect(updatePaymentStatus).toHaveBeenCalledWith(CHK_ID, PaymentStatus.SUCCESS);
  });

  it('backfills TXNID as gatewayPaymentId on first webhook', async () => {
    vi.mocked(findChkIdByGatewayId).mockResolvedValueOnce(null).mockResolvedValueOnce(CHK_ID);
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      gatewayPaymentId: '', // not yet set
    });

    await processWebhook('paytm', {}, {});

    expect(updateGatewayPaymentId).toHaveBeenCalledWith(CHK_ID, 'paytm', TXNID);
  });

  it('returns silently when both TXNID and ORDERID are unknown', async () => {
    vi.mocked(findChkIdByGatewayId).mockResolvedValue(null); // override default: always null

    await expect(processWebhook('paytm', {}, {})).resolves.toBeUndefined();

    expect(updatePaymentStatus).not.toHaveBeenCalled();
    expect(updateGatewayPaymentId).not.toHaveBeenCalled();
  });

  it('does not relay webhook when payment is not found via either lookup', async () => {
    vi.mocked(findChkIdByGatewayId).mockResolvedValue(null);

    await processWebhook('paytm', {}, {});

    expect(axios.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// State machine guard — terminal state protection
// ---------------------------------------------------------------------------

describe('processWebhook — state machine guard (Paytm)', () => {
  // These tests use direct TXNID lookup (default: CHK_ID found immediately)
  // No fallback is needed — we're testing status transition logic, not lookup.

  it('blocks SUCCESS → FAILED transition', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.SUCCESS,
      gatewayPaymentId: TXNID,
    });
    vi.mocked(mockPlugin.parseWebhookEvent).mockReturnValueOnce({
      ...mockPaytmWebhookEvent,
      status: PaymentStatus.FAILED,
    });

    await processWebhook('paytm', {}, {});

    // Invalid transition must NOT update Redis
    expect(updatePaymentStatus).not.toHaveBeenCalled();
  });

  it('blocks FAILED → SUCCESS transition', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.FAILED,
      gatewayPaymentId: TXNID,
    });
    vi.mocked(mockPlugin.parseWebhookEvent).mockReturnValueOnce({
      ...mockPaytmWebhookEvent,
      status: PaymentStatus.SUCCESS,
    });

    await processWebhook('paytm', {}, {});

    expect(updatePaymentStatus).not.toHaveBeenCalled();
  });

  it('blocks CANCELLED → PROCESSING transition', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.CANCELLED,
      gatewayPaymentId: TXNID,
    });
    vi.mocked(mockPlugin.parseWebhookEvent).mockReturnValueOnce({
      ...mockPaytmWebhookEvent,
      status: PaymentStatus.PROCESSING,
    });

    await processWebhook('paytm', {}, {});

    expect(updatePaymentStatus).not.toHaveBeenCalled();
  });

  it('blocks EXPIRED → SUCCESS transition (status reversal risk)', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.EXPIRED,
      gatewayPaymentId: TXNID,
    });
    vi.mocked(mockPlugin.parseWebhookEvent).mockReturnValueOnce({
      ...mockPaytmWebhookEvent,
      status: PaymentStatus.SUCCESS,
    });

    await processWebhook('paytm', {}, {});

    expect(updatePaymentStatus).not.toHaveBeenCalled();
  });

  it('allows PENDING → SUCCESS transition', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING,
      gatewayPaymentId: TXNID,
    });
    vi.mocked(mockPlugin.parseWebhookEvent).mockReturnValueOnce({
      ...mockPaytmWebhookEvent,
      status: PaymentStatus.SUCCESS,
    });

    await processWebhook('paytm', {}, {});

    expect(updatePaymentStatus).toHaveBeenCalledWith(CHK_ID, PaymentStatus.SUCCESS);
  });

  it('allows PENDING → FAILED transition', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING,
      gatewayPaymentId: TXNID,
    });
    vi.mocked(mockPlugin.parseWebhookEvent).mockReturnValueOnce({
      ...mockPaytmWebhookEvent,
      status: PaymentStatus.FAILED,
    });

    await processWebhook('paytm', {}, {});

    expect(updatePaymentStatus).toHaveBeenCalledWith(CHK_ID, PaymentStatus.FAILED);
  });

  it('allows PENDING → CANCELLED transition', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PENDING,
      gatewayPaymentId: TXNID,
    });
    vi.mocked(mockPlugin.parseWebhookEvent).mockReturnValueOnce({
      ...mockPaytmWebhookEvent,
      status: PaymentStatus.CANCELLED,
    });

    await processWebhook('paytm', {}, {});

    expect(updatePaymentStatus).toHaveBeenCalledWith(CHK_ID, PaymentStatus.CANCELLED);
  });

  it('allows PROCESSING → SUCCESS transition', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.PROCESSING,
      gatewayPaymentId: TXNID,
    });
    vi.mocked(mockPlugin.parseWebhookEvent).mockReturnValueOnce({
      ...mockPaytmWebhookEvent,
      status: PaymentStatus.SUCCESS,
    });

    await processWebhook('paytm', {}, {});

    expect(updatePaymentStatus).toHaveBeenCalledWith(CHK_ID, PaymentStatus.SUCCESS);
  });

  it('does NOT throw when invalid transition is blocked — returns silently', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValueOnce({
      ...mockStoredPayment,
      status: PaymentStatus.SUCCESS,
      gatewayPaymentId: TXNID,
    });
    vi.mocked(mockPlugin.parseWebhookEvent).mockReturnValueOnce({
      ...mockPaytmWebhookEvent,
      status: PaymentStatus.FAILED,
    });

    // Must not throw — returning 200 to Paytm prevents retry storms
    await expect(processWebhook('paytm', {}, {})).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe('processWebhook — Paytm signature verification', () => {
  it('propagates GatewayInvalidSignatureError when Paytm checksum is invalid', async () => {
    mockPlugin.parseWebhookEvent.mockImplementationOnce(() => {
      throw new GatewayInvalidSignatureError('paytm');
    });

    await expect(processWebhook('paytm', {}, {})).rejects.toThrow(GatewayInvalidSignatureError);
  });

  it('does not update Redis if checksum verification fails', async () => {
    mockPlugin.parseWebhookEvent.mockImplementationOnce(() => {
      throw new GatewayInvalidSignatureError('paytm');
    });

    try {
      await processWebhook('paytm', {}, {});
    } catch {
      // expected
    }

    expect(updatePaymentStatus).not.toHaveBeenCalled();
    expect(updateGatewayPaymentId).not.toHaveBeenCalled();
  });
});
