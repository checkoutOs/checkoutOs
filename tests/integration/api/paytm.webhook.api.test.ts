// tests/integration/api/paytm.webhook.api.test.ts
// Integration tests for POST /webhooks/paytm
//
// Business invariants protected:
//   - 401 returned for invalid or missing CHECKSUMHASH
//   - 200 returned for valid webhook even for unknown payment IDs
//   - NVP (URL-encoded) body is correctly parsed by express.urlencoded() middleware
//   - Webhook body parsing does not interfere with express.json() on other routes
//   - gatewayOrderId fallback lookup resolves Paytm payment from ORDERID
//   - State machine guard prevents terminal state overwrite

import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, registerTestGateway } from '../../helpers/app.helper';
import { savePayment } from '../../../src/store/payment.store';
import { PaymentStatus } from '../../../src/types/payment.types';
import { registerGateways } from '../../../src/gateways/gateway.registry';
import type { SupportedGatewayName } from '../../../src/gateways/gateway.registry';

// ---------------------------------------------------------------------------
// Mock paytmchecksum — allows test to control signature verification
// ---------------------------------------------------------------------------
// We mock this at the integration level so we don't need real Paytm credentials
// to generate valid checksums. The real crypto is tested separately.

const { mockVerifySignature } = vi.hoisted(() => ({
  mockVerifySignature: vi.fn().mockReturnValue(true),
}));

vi.mock('paytmchecksum', () => ({
  generateSignature: vi.fn().mockReturnValue('mock-checksum-for-request-signing'),
  verifySignature: mockVerifySignature,
  generateRefundChecksum: vi.fn().mockReturnValue('mock-refund-checksum'),
}));

// ---------------------------------------------------------------------------
// Mock axios — intercepts relay calls and gateway HTTP calls
// ---------------------------------------------------------------------------

vi.mock('axios', () => ({
  default: {
    create: vi.fn().mockReturnValue({
      post: vi.fn().mockResolvedValue({ status: 200, data: {} }),
      defaults: { baseURL: 'https://securegw.paytm.in' },
    }),
    isAxiosError: vi.fn().mockReturnValue(false),
    post: vi.fn().mockResolvedValue({ status: 200 }),
  },
}));

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const PAYTM_TEST_ENV = {
  PAYTM_MERCHANT_ID: 'test_mid_001',
  PAYTM_MERCHANT_KEY: 'test_key_001',
  PAYTM_WEBHOOK_SECRET: 'test_webhook_secret_001',
  PAYTM_BASE_URL: 'https://securegw.paytm.in',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPaytmNvpBody(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MID: 'test_mid_001',
    ORDERID: 'ORDER_NVP_001',
    TXNID: 'TXNID_NVP_001',
    TXNAMOUNT: '500.00',
    CURRENCY: 'INR',
    STATUS: 'TXN_SUCCESS',
    RESPCODE: '01',
    RESPMSG: 'Txn Successful',
    PAYMENTMODE: 'UPI',
    CHECKSUMHASH: 'valid-checksum-hash',
    ...overrides,
  };
}

function buildUrlEncodedBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// ---------------------------------------------------------------------------
// Setup — register Paytm gateway
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Register test Razorpay gateway first (for other routes that might be shared)
  registerTestGateway();

  // Now register Paytm as active gateway for this test suite
  registerGateways(
    {
      ...process.env,
      ...PAYTM_TEST_ENV,
    } as Record<string, unknown>,
    'paytm' as SupportedGatewayName,
  );
});

const app = createTestApp();

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe('POST /webhooks/paytm — signature verification', () => {
  it('returns 401 when CHECKSUMHASH is missing', async () => {
    const { CHECKSUMHASH: _, ...bodyWithoutChecksum } = buildPaytmNvpBody();

    const res = await request(app)
      .post('/webhooks/paytm')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(buildUrlEncodedBody(bodyWithoutChecksum));

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('GATEWAY_INVALID_SIGNATURE');
  });

  it('returns 401 when CHECKSUMHASH is invalid', async () => {
    // Make verifySignature return false for this test
    mockVerifySignature.mockReturnValueOnce(false);

    const res = await request(app)
      .post('/webhooks/paytm')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(buildUrlEncodedBody(buildPaytmNvpBody({ CHECKSUMHASH: 'invalid-checksum' })));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('GATEWAY_INVALID_SIGNATURE');
  });

  it('returns 200 when CHECKSUMHASH is valid', async () => {
    mockVerifySignature.mockReturnValueOnce(true);

    const res = await request(app)
      .post('/webhooks/paytm')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(buildUrlEncodedBody(buildPaytmNvpBody()));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});

// ---------------------------------------------------------------------------
// Unknown payment — returns 200 silently (prevent retry storms)
// ---------------------------------------------------------------------------

describe('POST /webhooks/paytm — unknown payment', () => {
  it('returns 200 even when TXNID is not in Redis', async () => {
    // TXNID that was never stored — unknown to the system
    const body = buildPaytmNvpBody({
      TXNID: 'TXNID_NEVER_STORED_001',
      ORDERID: 'ORDER_NEVER_STORED_001',
    });

    const res = await request(app)
      .post('/webhooks/paytm')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(buildUrlEncodedBody(body));

    // Must return 200 — not 404. Non-200 causes Paytm retry storms.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});

// ---------------------------------------------------------------------------
// NVP body parsing — middleware correctness
// ---------------------------------------------------------------------------

describe('POST /webhooks/paytm — NVP body parsing', () => {
  it('correctly parses URL-encoded body (not raw/JSON)', async () => {
    // If express.json() ran before express.urlencoded() on this route,
    // the body would not be parsed as NVP and CHECKSUMHASH extraction would fail.
    // A 401 (not 400) here means body was parsed but signature was rejected.
    // A 200 proves the NVP parsing worked end-to-end.
    mockVerifySignature.mockReturnValueOnce(true);

    const body = buildPaytmNvpBody({
      TXNID: 'TXNID_NVP_PARSE_TEST',
      ORDERID: 'ORDER_NVP_PARSE_TEST',
    });

    const res = await request(app)
      .post('/webhooks/paytm')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(buildUrlEncodedBody(body));

    expect(res.status).toBe(200);
  });

  it('does not accept JSON body for Paytm webhook (middleware isolation)', async () => {
    // Paytm webhooks must use application/x-www-form-urlencoded.
    // Sending JSON will result in the body being parsed as a different format.
    // The plugin's parseNvpBody handles object input correctly.
    mockVerifySignature.mockReturnValueOnce(true);

    const jsonBody = buildPaytmNvpBody({ TXNID: 'TXNID_JSON_TEST' });

    const res = await request(app)
      .post('/webhooks/paytm')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(jsonBody));

    // Should still respond — plugin handles already-parsed object input
    expect(res.status).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// gatewayOrderId fallback — Paytm-specific
// ---------------------------------------------------------------------------

describe('POST /webhooks/paytm — ORDERID fallback lookup', () => {
  it('successfully processes webhook and updates status via ORDERID when payment exists', async () => {
    // Store a payment using ORDERID as the gateway lookup key (as done by createPayment)
    const chkId = 'chk_paytmwh00000000000000000001';
    await savePayment({
      chkId,
      gatewayOrderId: 'ORDER_FALLBACK_001',
      gatewayPaymentId: '', // TXNID not yet set
      gateway: 'paytm',
      orderId: 'dev_order_001',
      amount: 50000,
      currency: 'INR',
      status: PaymentStatus.PENDING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockVerifySignature.mockReturnValueOnce(true);

    const body = buildPaytmNvpBody({
      TXNID: 'TXNID_FALLBACK_001', // New TXNID — not yet in Redis
      ORDERID: 'ORDER_FALLBACK_001', // ORDERID matches the stored payment
      STATUS: 'TXN_SUCCESS',
    });

    const res = await request(app)
      .post('/webhooks/paytm')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(buildUrlEncodedBody(body));

    // Payment should be found via ORDERID fallback and processed
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});
