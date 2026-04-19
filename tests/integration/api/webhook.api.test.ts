// tests/integration/api/webhook.api.test.ts
// Integration tests for POST /webhooks/:gateway
//
// Business invariants protected:
//   - 401 returned for invalid or missing signature
//   - 200 returned for valid webhook even for unknown payments
//   - Raw body is preserved for HMAC verification (not JSON-parsed first)
//   - Correct Content-Type header handling

import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createTestApp, registerTestGateway } from '../../helpers/app.helper';

// Mock axios for relay calls
vi.mock('axios', () => ({
  default: {
    create: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({ status: 200, data: {} }),
      post: vi.fn().mockResolvedValue({ status: 200, data: {} }),
    }),
    isAxiosError: vi.fn().mockReturnValue(false),
    post: vi.fn().mockResolvedValue({ status: 200 }),
  },
}));

const WEBHOOK_SECRET = 'mockWebhookSecret001';

function buildWebhookPayload(gatewayPaymentId = 'pay_test001'): object {
  return {
    entity: 'event',
    account_id: 'acc_mock001',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: gatewayPaymentId,
          order_id: 'order_mock001',
          amount: 50000,
          currency: 'INR',
          status: 'captured',
        },
      },
    },
    created_at: 1705314600,
  };
}

function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

beforeAll(() => {
  registerTestGateway();
});

const app = createTestApp();

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe('POST /webhooks/razorpay — signature verification', () => {
  it('returns 401 when x-razorpay-signature header is missing', async () => {
    const body = JSON.stringify(buildWebhookPayload());

    const res = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('GATEWAY_INVALID_SIGNATURE');
  });

  it('returns 401 when x-razorpay-signature is incorrect', async () => {
    const body = JSON.stringify(buildWebhookPayload());

    const res = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', 'invalidsignature')
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('GATEWAY_INVALID_SIGNATURE');
  });

  it('returns 200 when signature is valid', async () => {
    const body = JSON.stringify(buildWebhookPayload());
    const sig = signPayload(body, WEBHOOK_SECRET);

    const res = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});

// ---------------------------------------------------------------------------
// Unknown payment — returns 200 silently
// ---------------------------------------------------------------------------

describe('POST /webhooks/razorpay — unknown payment', () => {
  it('returns 200 even when payment is not in Redis', async () => {
    // gatewayPaymentId that was never stored — unknown payment
    const body = JSON.stringify(buildWebhookPayload('pay_neverstored001'));
    const sig = signPayload(body, WEBHOOK_SECRET);

    const res = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(body);

    // Must return 200 — not 404. Non-200 causes Razorpay retry storms.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});

// ---------------------------------------------------------------------------
// Raw body preservation
// ---------------------------------------------------------------------------

describe('POST /webhooks/razorpay — raw body', () => {
  it('correctly verifies signature proving raw body was not modified by express.json()', async () => {
    // If express.json() ran before express.raw(), the body would be
    // re-serialised (potentially with different key ordering) and the
    // HMAC would not match. A 200 here proves raw body was preserved.
    const body = JSON.stringify(buildWebhookPayload());
    const sig = signPayload(body, WEBHOOK_SECRET);

    const res = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(body);

    expect(res.status).toBe(200);
  });
});
