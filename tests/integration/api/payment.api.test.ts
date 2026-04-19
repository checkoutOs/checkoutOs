// tests/integration/api/payment.api.test.ts
// Integration tests for payment endpoints.
//
// Endpoints covered:
//   POST /payments
//   GET  /payments/:chkId
//   POST /payments/:chkId/refund
//
// Uses real Redis + real Express. Gateway HTTP calls are intercepted via
// axios mock so no real Razorpay API calls are made.
//
// Business invariants protected:
//   - 201 returned for successful payment creation
//   - 400 returned for invalid amount
//   - 404 returned for unknown chkId
//   - 422 returned for refund on non-SUCCESS payment
//   - Response shapes always match ApiResponse contract

import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, registerTestGateway } from '../../helpers/app.helper';
import { PaymentStatus } from '../../../src/types/payment.types';

// ---------------------------------------------------------------------------
// Mock axios — intercepts all gateway HTTP calls
// ---------------------------------------------------------------------------
// vi.mock() is hoisted before variable declarations — any variable
// referenced inside the factory must be defined inside the factory itself.
// Use vi.hoisted() to create mocks that are available at hoist time.

const { mockAxiosPost, mockAxiosGet } = vi.hoisted(() => ({
  mockAxiosPost: vi.fn(),
  mockAxiosGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn().mockReturnValue({
      post: mockAxiosPost,
      get: mockAxiosGet,
    }),
    isAxiosError: vi.fn().mockReturnValue(false),
    post: vi.fn().mockResolvedValue({ status: 200 }),
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  registerTestGateway();

  // Default: createPayment (POST /orders) returns a valid order
  mockAxiosPost.mockResolvedValue({
    status: 200,
    data: {
      id: 'order_integtest_001',
      entity: 'order',
      amount: 50000,
      amount_paid: 0,
      amount_due: 50000,
      currency: 'INR',
      receipt: 'dev_order_001',
      status: 'created',
      attempts: 0,
      created_at: 1705314600,
    },
  });

  // Default: getPaymentStatus (GET /orders/:id) returns created order
  mockAxiosGet.mockResolvedValue({
    status: 200,
    data: {
      id: 'order_integtest_001',
      entity: 'order',
      amount: 50000,
      amount_paid: 0,
      amount_due: 50000,
      currency: 'INR',
      receipt: 'dev_order_001',
      status: 'created',
      attempts: 0,
      created_at: 1705314600,
    },
  });
});

const app = createTestApp();

const validPaymentBody = {
  amount: 50000,
  currency: 'INR',
  orderId: 'dev_order_001',
};

// ---------------------------------------------------------------------------
// POST /payments
// ---------------------------------------------------------------------------

describe('POST /payments', () => {
  it('returns 201 with paymentId and paymentUrl on success', async () => {
    const res = await request(app).post('/payments').send(validPaymentBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.paymentId).toMatch(/^chk_/);
    expect(res.body.data.paymentUrl).toBeDefined();
    expect(res.body.data.status).toBe(PaymentStatus.PENDING);
  });

  it('returns 201 with correct amount and currency', async () => {
    const res = await request(app).post('/payments').send(validPaymentBody);

    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(50000);
    expect(res.body.data.currency).toBe('INR');
  });

  it('returns 400 for zero amount', async () => {
    const res = await request(app)
      .post('/payments')
      .send({ ...validPaymentBody, amount: 0 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
  });

  it('returns 400 for negative amount', async () => {
    const res = await request(app)
      .post('/payments')
      .send({ ...validPaymentBody, amount: -500 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for non-integer amount', async () => {
    const res = await request(app)
      .post('/payments')
      .send({ ...validPaymentBody, amount: 499.99 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('response shape matches ApiSuccessResponse contract', async () => {
    const res = await request(app).post('/payments').send(validPaymentBody);

    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('paymentId');
    expect(res.body.data).toHaveProperty('paymentUrl');
    expect(res.body.data).toHaveProperty('status');
    expect(res.body.data).toHaveProperty('amount');
    expect(res.body.data).toHaveProperty('currency');
    expect(res.body.data).toHaveProperty('createdAt');
  });

  it('error shape matches ApiErrorResponse contract', async () => {
    const res = await request(app)
      .post('/payments')
      .send({ ...validPaymentBody, amount: 0 });

    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
  });
});

// ---------------------------------------------------------------------------
// GET /payments/:chkId
// ---------------------------------------------------------------------------

describe('GET /payments/:chkId', () => {
  it('returns 200 with payment status for existing payment', async () => {
    // First create a payment to get a real chkId
    const createRes = await request(app).post('/payments').send(validPaymentBody);

    const chkId = createRes.body.data.paymentId;

    const statusRes = await request(app).get(`/payments/${chkId}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.success).toBe(true);
    expect(statusRes.body.data.paymentId).toBe(chkId);
    expect(statusRes.body.data.status).toBeDefined();
  });

  it('returns 404 for unknown chkId', async () => {
    const res = await request(app).get('/payments/chk_doesnotexist00000000000000');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
  });

  it('returns correct response shape', async () => {
    const createRes = await request(app).post('/payments').send(validPaymentBody);

    const chkId = createRes.body.data.paymentId;
    const statusRes = await request(app).get(`/payments/${chkId}`);

    expect(statusRes.body.data).toHaveProperty('paymentId');
    expect(statusRes.body.data).toHaveProperty('status');
    expect(statusRes.body.data).toHaveProperty('amount');
    expect(statusRes.body.data).toHaveProperty('currency');
    expect(statusRes.body.data).toHaveProperty('createdAt');
    expect(statusRes.body.data).toHaveProperty('updatedAt');
  });
});

// ---------------------------------------------------------------------------
// POST /payments/:chkId/refund
// ---------------------------------------------------------------------------

describe('POST /payments/:chkId/refund', () => {
  it('returns 422 when payment is in PENDING status (not refundable)', async () => {
    // Create payment — it starts as PENDING
    const createRes = await request(app).post('/payments').send(validPaymentBody);

    const chkId = createRes.body.data.paymentId;

    const refundRes = await request(app).post(`/payments/${chkId}/refund`).send({});

    // PENDING payments cannot be refunded
    expect(refundRes.status).toBe(422);
    expect(refundRes.body.success).toBe(false);
    expect(refundRes.body.error.code).toBe('REFUND_NOT_ALLOWED');
  });

  it('returns 404 for refund on unknown payment', async () => {
    const res = await request(app).post('/payments/chk_doesnotexist00000000000000/refund').send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Unknown routes
// ---------------------------------------------------------------------------

describe('unknown routes', () => {
  it('returns 404 with NOT_FOUND code for unknown path', async () => {
    const res = await request(app).get('/payments/unknown/deep/path');

    expect(res.status).toBe(404);
  });
});
