// tests/integration/api/refund.api.test.ts
// Integration tests for GET /refunds/:refId

import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, registerTestGateway } from '../../helpers/app.helper';
import { saveRefund } from '../../../src/store/refund.store';
import { RefundStatus } from '../../../src/types/payment.types';

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

beforeAll(() => {
  registerTestGateway();
});

const app = createTestApp();

describe('GET /refunds/:refId', () => {
  it('returns 200 with refund status for existing refund', async () => {
    const refund = {
      refId: 'ref_apitest000000000000000000001',
      chkId: 'chk_apitest000000000000000000001',
      gatewayRefundId: 'rfnd_apitest001',
      gateway: 'razorpay',
      amount: 50000,
      currency: 'INR' as const,
      status: RefundStatus.SUCCESS,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveRefund(refund);

    const res = await request(app).get(`/refunds/${refund.refId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.refundId).toBe(refund.refId);
    expect(res.body.data.status).toBe(RefundStatus.SUCCESS);
  });

  it('returns 404 for unknown refId', async () => {
    const res = await request(app).get('/refunds/ref_doesnotexist0000000000000000');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('REFUND_NOT_FOUND');
  });

  it('response shape matches RefundStatusResponse contract', async () => {
    const refund = {
      refId: 'ref_apitest000000000000000000002',
      chkId: 'chk_apitest000000000000000000002',
      gatewayRefundId: 'rfnd_apitest002',
      gateway: 'razorpay',
      amount: 25000,
      currency: 'INR' as const,
      status: RefundStatus.PENDING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveRefund(refund);

    const res = await request(app).get(`/refunds/${refund.refId}`);

    expect(res.body.data).toHaveProperty('refundId');
    expect(res.body.data).toHaveProperty('paymentId');
    expect(res.body.data).toHaveProperty('status');
    expect(res.body.data).toHaveProperty('amount');
    expect(res.body.data).toHaveProperty('currency');
    expect(res.body.data).toHaveProperty('createdAt');
    expect(res.body.data).toHaveProperty('updatedAt');
  });
});
