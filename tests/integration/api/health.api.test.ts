// tests/integration/api/health.api.test.ts
// Integration tests for GET /health
//
// Tests the full HTTP layer: Express app → HealthController → HealthService
// Uses real Redis. Gateway healthCheck is mocked (axios intercepted).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, registerTestGateway } from '../../helpers/app.helper';

// Mock axios so healthCheck() does not hit real Razorpay
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

describe('GET /health', () => {
  it('returns 200 with status ok when all services are healthy', async () => {
    const app = createTestApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
  });

  it('response includes timestamp', async () => {
    const app = createTestApp();
    const res = await request(app).get('/health');

    expect(res.body.data.timestamp).toBeDefined();
    expect(typeof res.body.data.timestamp).toBe('string');
  });

  it('response includes redis and gateway service health', async () => {
    const app = createTestApp();
    const res = await request(app).get('/health');

    expect(res.body.data.services.redis).toBeDefined();
    expect(res.body.data.services.gateway).toBeDefined();
    expect(res.body.data.services.redis.healthy).toBe(true);
  });

  it('response shape always has success wrapper', async () => {
    const app = createTestApp();
    const res = await request(app).get('/health');

    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
  });
});
