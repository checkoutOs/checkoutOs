// tests/integration/paytm.checkout.test.ts
// Integration tests for GET /checkout/:chkId with Paytm gateway.
//
// Business invariants protected:
//   - PENDING payment → 302 redirect to Paytm payment URL (not HTML render)
//   - PROCESSING payment → 302 redirect to Paytm payment URL
//   - SUCCESS payment → 200 HTML success page (no redirect)
//   - FAILED payment → 200 HTML failure page (no redirect)
//   - Redirect URL contains the correct order ID
//   - Controller is gateway-agnostic — no Paytm-specific logic in controller

import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app.helper';
import { savePayment } from '../../src/store/payment.store';
import { PaymentStatus } from '../../src/types/payment.types';
import { registerGateways } from '../../src/gateways/gateway.registry';
import type { SupportedGatewayName } from '../../src/gateways/gateway.registry';

// ---------------------------------------------------------------------------
// Mock paytmchecksum (needed by PaytmPlugin constructor / request signing)
// ---------------------------------------------------------------------------

vi.mock('paytmchecksum', () => ({
  generateSignature: vi.fn().mockReturnValue('mock-signature'),
  verifySignature: vi.fn().mockReturnValue(true),
  generateRefundChecksum: vi.fn().mockReturnValue('mock-refund-checksum'),
}));

// ---------------------------------------------------------------------------
// Mock axios — no real HTTP calls to Paytm API
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
// Setup — register Paytm gateway
// ---------------------------------------------------------------------------

beforeAll(() => {
  registerGateways(
    {
      ...process.env,
      PAYTM_MERCHANT_ID: 'checkout_test_mid',
      PAYTM_MERCHANT_KEY: 'checkout_test_key',
      PAYTM_WEBHOOK_SECRET: 'checkout_test_secret',
    } as Record<string, unknown>,
    'paytm' as SupportedGatewayName,
  );
});

const app = createTestApp();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createPaytmPayment(
  chkId: string,
  status: PaymentStatus,
  gatewayOrderId = 'ORDER_CHK_001',
): Promise<void> {
  await savePayment({
    chkId,
    gatewayOrderId,
    gatewayPaymentId: '',
    gateway: 'paytm',
    orderId: 'dev_order_001',
    amount: 50000,
    currency: 'INR',
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// PENDING → redirect
// ---------------------------------------------------------------------------

describe('GET /checkout/:chkId — Paytm PENDING payment', () => {
  it('returns 302 redirect for PENDING payment', async () => {
    const chkId = 'chk_paytmco00000000000000000001';
    await createPaytmPayment(chkId, PaymentStatus.PENDING, 'ORDER_PENDING_001');

    const res = await request(app).get(`/checkout/${chkId}`);

    expect(res.status).toBe(302);
  });

  it('redirects to a URL containing the order ID', async () => {
    const chkId = 'chk_paytmco00000000000000000002';
    await createPaytmPayment(chkId, PaymentStatus.PENDING, 'ORDER_REDIRECT_001');

    const res = await request(app).get(`/checkout/${chkId}`);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBeDefined();
    expect(res.headers['location']).toContain('ORDER_REDIRECT_001');
  });

  it('redirect URL points to Paytm payment page', async () => {
    const chkId = 'chk_paytmco00000000000000000003';
    await createPaytmPayment(chkId, PaymentStatus.PENDING, 'ORDER_PAGE_001');

    const res = await request(app).get(`/checkout/${chkId}`);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain('showPaymentPage');
  });

  it('redirect URL contains the merchant ID', async () => {
    const chkId = 'chk_paytmco00000000000000000004';
    await createPaytmPayment(chkId, PaymentStatus.PENDING, 'ORDER_MID_001');

    const res = await request(app).get(`/checkout/${chkId}`);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain('checkout_test_mid');
  });
});

// ---------------------------------------------------------------------------
// PROCESSING → redirect (still active payment, not terminal)
// ---------------------------------------------------------------------------

describe('GET /checkout/:chkId — Paytm PROCESSING payment', () => {
  it('returns 302 redirect for PROCESSING payment', async () => {
    const chkId = 'chk_paytmco00000000000000000005';
    await createPaytmPayment(chkId, PaymentStatus.PROCESSING, 'ORDER_PROC_001');

    const res = await request(app).get(`/checkout/${chkId}`);

    expect(res.status).toBe(302);
  });
});

// ---------------------------------------------------------------------------
// SUCCESS → render HTML (terminal state, no redirect)
// ---------------------------------------------------------------------------

describe('GET /checkout/:chkId — Paytm SUCCESS payment', () => {
  it('returns 200 HTML success page (not redirect) for SUCCESS payment', async () => {
    const chkId = 'chk_paytmco00000000000000000006';
    await createPaytmPayment(chkId, PaymentStatus.SUCCESS, 'ORDER_SUCCESS_001');

    const res = await request(app).get(`/checkout/${chkId}`);

    // Terminal SUCCESS must render HTML, not redirect
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('HTML response does not contain a Location redirect header', async () => {
    const chkId = 'chk_paytmco00000000000000000007';
    await createPaytmPayment(chkId, PaymentStatus.SUCCESS, 'ORDER_SUCCESS_002');

    const res = await request(app).get(`/checkout/${chkId}`);

    expect(res.status).toBe(200);
    expect(res.headers['location']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FAILED → render HTML (terminal state, no redirect)
// ---------------------------------------------------------------------------

describe('GET /checkout/:chkId — Paytm FAILED payment', () => {
  it('returns 200 HTML failure page (not redirect) for FAILED payment', async () => {
    const chkId = 'chk_paytmco00000000000000000008';
    await createPaytmPayment(chkId, PaymentStatus.FAILED, 'ORDER_FAILED_001');

    const res = await request(app).get(`/checkout/${chkId}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

// ---------------------------------------------------------------------------
// Unknown payment
// ---------------------------------------------------------------------------

describe('GET /checkout/:chkId — unknown payment', () => {
  it('returns 404 for unknown chkId', async () => {
    const res = await request(app).get('/checkout/chk_doesnotexist00000000000000');

    expect(res.status).toBe(404);
  });
});
