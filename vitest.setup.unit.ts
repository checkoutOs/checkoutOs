// vitest.setup.unit.ts
// Runs once before all unit tests.
//
// Primary job: replace ioredis with ioredis-mock so unit tests never
// open real Redis connections. This is done via vi.mock() at the module
// level — every file that imports 'ioredis' gets the mock instead.
//
// Why mock at this level rather than in each test file:
//   redis.client.ts creates the ioredis instance at module load time.
//   If the real ioredis loads first, it tries to connect to Redis immediately.
//   Mocking here intercepts the import before any test file loads redis.client.

import { vi, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// Mock ioredis with ioredis-mock
// ---------------------------------------------------------------------------
// ioredis-mock is a drop-in replacement that runs entirely in memory.
// All ioredis API methods (hset, hgetall, get, set, pipeline, etc.) are
// supported. The mock state is isolated per test run.

vi.mock('ioredis', async () => {
  const { default: RedisMock } = await import('ioredis-mock');
  return {
    default: RedisMock,
  };
});

// ---------------------------------------------------------------------------
// Silence Winston logs during tests
// ---------------------------------------------------------------------------
// Tests produce a lot of expected errors (testing error paths).
// Logging these to stdout makes test output unreadable.
// The logger already has `silent: config.isTest` — this is belt-and-suspenders.

vi.mock('./src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createContextLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Set test environment variables
// ---------------------------------------------------------------------------
// Must be set at the top level — not inside beforeAll().
// config/index.ts calls EnvSchema.safeParse(process.env) at module load
// time. By the time beforeAll() runs, config has already been imported
// and parsed. Setting vars here ensures they exist before any import runs.

process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3001';
process.env['ACTIVE_GATEWAY'] = 'razorpay';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['WEBHOOK_RELAY_URL'] = 'http://localhost:4000/webhook';
process.env['RAZORPAY_KEY_ID'] = 'rzp_test_mockKeyId00001';
process.env['RAZORPAY_KEY_SECRET'] = 'mockSecret00001';
process.env['RAZORPAY_WEBHOOK_SECRET'] = 'mockWebhookSecret001';
process.env['RAZORPAY_BASE_URL'] = 'http://localhost:9090';

afterAll(() => {
  vi.restoreAllMocks();
});
