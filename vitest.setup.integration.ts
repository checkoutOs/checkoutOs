// vitest.setup.integration.ts
// Runs once before all integration tests.
//
// Integration tests use:
//   - Real Redis (must be running: docker start checkoutos-redis)
//   - Real Express app via supertest
//   - Mocked axios (gateway HTTP calls intercepted)
//
// This file handles:
//   1. Environment variable setup
//   2. Redis connection and cleanup between test files
//   3. Mocking axios so no real Razorpay calls are made

// Environment variables must be set BEFORE any imports that trigger
// config/index.ts — which calls EnvSchema.safeParse(process.env) at
// module load time. Setting them inside beforeAll() is too late.
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3002';
process.env['ACTIVE_GATEWAY'] = 'razorpay';
process.env['REDIS_URL'] = 'redis://localhost:6379';
// process.env['WEBHOOK_RELAY_URL'] = 'http://localhost:4000/webhook';
process.env['WEBHOOK_RELAY_URL'] = 'http://localhost:4000/webhook';
process.env['RAZORPAY_KEY_ID'] = 'rzp_test_ScXYBsKGwIyIZB';
process.env['RAZORPAY_KEY_SECRET'] = 'J3LBUwiMOmQWr6uMCFEo8Wqd';
process.env['RAZORPAY_WEBHOOK_SECRET'] = 'mockWebhookSecret001';
process.env['RAZORPAY_BASE_URL'] = 'https://api.razorpay.com/v1';

import { vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectRedis, disconnectRedis, redisClient } from './src/store/redis.client';
import { configureLogger } from './src/utils/logger';

// ---------------------------------------------------------------------------
// Silence logger in integration tests too
// ---------------------------------------------------------------------------

// The REAL logger runs in tests — no mock, so tests never drift from the
// logger's actual shape. This setup file is the test composition root: like
// server.ts in production, it hands the logger its settings. isTest sets
// logger.silent. A test that needs output can call configureLogger() itself.
configureLogger({ isTest: true, isDevelopment: false });

// ---------------------------------------------------------------------------
// Redis lifecycle
// ---------------------------------------------------------------------------
// Connect once before all integration tests.
// Flush all test keys before each test file to prevent cross-contamination.
// Disconnect cleanly after all tests finish.

beforeAll(async () => {
  await connectRedis();
});

beforeEach(async () => {
  // Flush only keys written by tests — use a test-specific key prefix
  // pattern so we never accidentally flush production data if someone
  // runs integration tests against a shared Redis.
  const keys = await redisClient.keys('chk:*');
  if (keys.length > 0) {
    await redisClient.del(...keys);
  }
});

afterAll(async () => {
  // Final cleanup
  const keys = await redisClient.keys('chk:*');
  if (keys.length > 0) {
    await redisClient.del(...keys);
  }
  await disconnectRedis();
  vi.restoreAllMocks();
});
