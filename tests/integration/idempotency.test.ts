// tests/integration/idempotency.test.ts
// Integration tests for POST /payments idempotency (plan §10.4/§10.5 checklist).
//
// Real Redis + real Express + real razorpay plugin over real HTTP — the only
// external dependency is the local MSW mock gateway on :9090 (start it with
// `npm run mock:gateway`), which is this repo's documented integration-test
// isolation strategy (AGENTS.md → Testing).
//
// IMPORTANT: vi.mock of src modules does NOT work in the integration project
// (verified: a mocked razorpay.plugin factory was never invoked by
// gateway.registry; per-file axios mocks never intercepted either — requests
// silently reached the REAL Razorpay API). Do not convert these tests back to
// module mocks without re-verifying interception.
//
// NOTE on status codes: the implementation plan's examples assert 200 for
// creation, but the actual controller contract is 201 Created — tests here
// assert 201.
//
// NOTE on request hashing: the middleware hashes the mount-aware path
// (req.baseUrl + req.path), so a request to POST /payments hashes as
// '/payments' — not the router-relative '/'. Scenario (h) seeds Redis directly
// and must reproduce the middleware's exact hash:
//   generateRequestHash('POST', '/payments', body)
//
// Business invariants protected (plan §1.4 success criteria):
//   - Same request twice returns the same response
//   - Different payload with same key returns 400 IDEMPOTENCY_KEY_REUSED
//   - Parallel requests: one succeeds, the other gets 409 REQUEST_IN_PROGRESS
//   - Stale IN_PROGRESS records auto-recover past the 30s window

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp, registerTestGateway } from '../helpers/app.helper';
import { redisClient } from '../../src/store/redis.client';
import { generateRequestHash } from '../../src/utils/hash';
import type { IdempotencyRecord } from '../../src/types/common.types';

// ---------------------------------------------------------------------------
// Point the gateway at the LOCAL MSW mock server (never the real API).
// Must run before registerTestGateway() — the plugin snapshots baseUrl and
// credentials at construction time inside registerGateways().
// ---------------------------------------------------------------------------

process.env['RAZORPAY_BASE_URL'] = 'http://localhost:9090/v1';
process.env['RAZORPAY_KEY_ID'] = 'rzp_test_mockKeyId00001';
process.env['RAZORPAY_KEY_SECRET'] = 'mockSecret00001';

beforeAll(() => {
  // Guard: fail fast with a clear message if the mock gateway isn't running,
  // instead of surfacing confusing connection-refused 502s per test.
  registerTestGateway();
});

const app = createTestApp();

function freshKey(): string {
  return randomUUID();
}

function validBody(orderId: string): {
  amount: number;
  currency: string;
  orderId: string;
} {
  return { amount: 50000, currency: 'INR', orderId };
}

/** Seed an IN_PROGRESS record directly in Redis with a backdated updatedAt. */
async function seedStaleRecord(key: string, requestHash: string, ageMs: number): Promise<void> {
  const backdated = new Date(Date.now() - ageMs).toISOString();
  const record: IdempotencyRecord = {
    requestHash,
    status: 'IN_PROGRESS',
    createdAt: backdated,
    updatedAt: backdated,
  };
  await redisClient.set(`chk:idem:${key}`, JSON.stringify(record));
}

vi.setConfig({ testTimeout: 15_000 });

// ---------------------------------------------------------------------------
// Plan §10.5 checklist scenarios
// ---------------------------------------------------------------------------

describe('POST /payments — idempotency', () => {
  beforeEach(async () => {
    // Extra safety beyond the global chk:* flush: ensure a clean slate so
    // orderId dedup and idempotency records never leak between scenarios.
    const keys = await redisClient.keys('chk:*');
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
  });

  it('returns the SAME response when the same payload is sent twice (a)', async () => {
    const key = freshKey();
    const body = validBody(`order_a_${Date.now()}`);

    const res1 = await request(app).post('/payments').set('Idempotency-Key', key).send(body);
    expect(res1.status).toBe(201);

    const res2 = await request(app).post('/payments').set('Idempotency-Key', key).send(body);

    // Second request replays the cached HIT — identical payment identity.
    expect(res2.status).toBe(201);
    expect(res2.body.data.paymentId).toBe(res1.body.data.paymentId);
    expect(res2.body.data.paymentUrl).toBe(res1.body.data.paymentUrl);
    expect(res2.body.data.orderId).toBe(body.orderId);
  });

  it('rejects a DIFFERENT payload with the same key (b)', async () => {
    const key = freshKey();

    await request(app)
      .post('/payments')
      .set('Idempotency-Key', key)
      .send(validBody(`order_b_${Date.now()}`));

    const res = await request(app)
      .post('/payments')
      .set('Idempotency-Key', key)
      .send({ amount: 100000, currency: 'INR', orderId: `order_b2_${Date.now()}` });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('lets only ONE of two parallel identical requests through (c)', async () => {
    const key = freshKey();
    const body = validBody(`order_c_${Date.now()}`);

    const [res1, res2] = await Promise.all([
      request(app).post('/payments').set('Idempotency-Key', key).send(body),
      request(app).post('/payments').set('Idempotency-Key', key).send(body),
    ]);

    const statuses = [res1.status, res2.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);

    const conflict = res1.status === 409 ? res1 : res2;
    expect(conflict.body.error.code).toBe('REQUEST_IN_PROGRESS');
  });

  it('rejects a missing Idempotency-Key header with 400 (d)', async () => {
    const res = await request(app)
      .post('/payments')
      .send(validBody(`order_d_${Date.now()}`));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('rejects a non-UUID Idempotency-Key with 400 (e)', async () => {
    const res = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'not-a-uuid')
      .send(validBody(`order_e_${Date.now()}`));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('rejects a different AMOUNT reused on the same orderId with 409 (f)', async () => {
    const orderId = `order_f_${Date.now()}`;

    await request(app)
      .post('/payments')
      .set('Idempotency-Key', freshKey())
      .send({ amount: 50000, currency: 'INR', orderId });

    const res = await request(app)
      .post('/payments')
      .set('Idempotency-Key', freshKey()) // different key → passes dedup, hits orderId check
      .send({ amount: 100000, currency: 'INR', orderId }); // same orderId, new amount

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_ID_AMOUNT_MISMATCH');
  });

  it('rejects a different CURRENCY reused on the same orderId with 409 (g)', async () => {
    const orderId = `order_g_${Date.now()}`;

    await request(app)
      .post('/payments')
      .set('Idempotency-Key', freshKey())
      .send({ amount: 50000, currency: 'INR', orderId });

    const res = await request(app)
      .post('/payments')
      .set('Idempotency-Key', freshKey())
      .send({ amount: 50000, currency: 'USD', orderId }); // same orderId+amount, new currency

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_ID_CURRENCY_MISMATCH');
  });

  it('auto-recovers a stale IN_PROGRESS record after the 30s window (h)', async () => {
    const key = freshKey();
    const body = validBody(`order_h_${Date.now()}`);

    // Simulate a crashed request: IN_PROGRESS record whose updatedAt is 31s old.
    // Hash must match what the middleware computes ('/' because of the mount).
    await seedStaleRecord(key, generateRequestHash('POST', '/payments', body), 31_000);

    const res = await request(app).post('/payments').set('Idempotency-Key', key).send(body);

    // Recovery treats the stale record as MISS → payment proceeds normally.
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    // The recovered record must now be COMPLETED with the payment cached.
    const stored = JSON.parse(
      (await redisClient.get(`chk:idem:${key}`)) ?? '{}',
    ) as IdempotencyRecord;
    expect(stored.status).toBe('COMPLETED');
  });
});

// ---------------------------------------------------------------------------
// BUG-012 — concurrent creates on the same orderId
// ---------------------------------------------------------------------------
// The idempotency key cannot help here: different keys are different SET NX
// targets, so every request legitimately wins its own claim. Only the orderId
// reservation prevents two gateway orders for one merchant order.

describe('POST /payments — concurrent same-orderId creation', () => {
  beforeEach(async () => {
    const keys = await redisClient.keys('chk:*');
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
  });

  it('lets only ONE of five parallel same-orderId requests create a payment', async () => {
    const orderId = `order_race_${String(Date.now())}`;
    const body = validBody(orderId);

    // Five DIFFERENT idempotency keys — the scenario the idempotency layer
    // cannot catch. Before the reservation this produced five gateway orders.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post('/payments').set('Idempotency-Key', freshKey()).send(body),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.body.error.code).toBe('ORDER_CREATION_IN_PROGRESS');
    }
  });

  it('leaves exactly one payment record behind after the race', async () => {
    const orderId = `order_race_single_${String(Date.now())}`;
    const body = validBody(orderId);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post('/payments').set('Idempotency-Key', freshKey()).send(body),
      ),
    );

    // One payment hash, and the index resolves to it. Two hashes here would
    // mean two gateway orders were created.
    const paymentKeys = await redisClient.keys('chk:pay:chk_*');
    expect(paymentKeys).toHaveLength(1);

    const indexed = await redisClient.get(`chk:pay:by-order:${orderId}`);
    expect(paymentKeys[0]).toBe(`chk:pay:${String(indexed)}`);
  });

  it('serves the committed payment to a later request instead of 409', async () => {
    const orderId = `order_race_then_dedup_${String(Date.now())}`;
    const body = validBody(orderId);

    const first = await request(app)
      .post('/payments')
      .set('Idempotency-Key', freshKey())
      .send(body);
    expect(first.status).toBe(201);

    // Reservation is committed now, so the loser path finds a real payment and
    // dedups rather than returning ORDER_CREATION_IN_PROGRESS.
    const second = await request(app)
      .post('/payments')
      .set('Idempotency-Key', freshKey())
      .send(body);

    expect(second.status).toBe(201);
    expect(second.body.data.paymentId).toBe(first.body.data.paymentId);
  });
});

// ---------------------------------------------------------------------------
// BUG-003 — orderId validation
// ---------------------------------------------------------------------------

describe('POST /payments — orderId validation', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['colon (Redis key separator)', 'order:123'],
    ['over 64 chars', 'o'.repeat(65)],
  ])('rejects an orderId that is %s with 400', async (_label, orderId) => {
    const res = await request(app)
      .post('/payments')
      .set('Idempotency-Key', freshKey())
      .send({ amount: 50000, currency: 'INR', orderId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ORDER_ID');
  });

  it('never creates a chk:pay:by-order:undefined key', async () => {
    await request(app)
      .post('/payments')
      .set('Idempotency-Key', freshKey())
      .send({ amount: 50000, currency: 'INR' });

    // The BUG-003 failure mode: every malformed request collapsing onto one
    // shared key, so one caller could be handed another caller's payment.
    expect(await redisClient.exists('chk:pay:by-order:undefined')).toBe(0);
  });
});
