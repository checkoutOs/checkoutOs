// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  test: {
    projects: [
      // ── Unit tests ────────────────────────────────────────────────────────
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./vitest.setup.unit.ts'],
          testTimeout: 5_000,
          globals: true,
        },
      },

      // ── Integration tests ─────────────────────────────────────────────────
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./vitest.setup.integration.ts'],
          testTimeout: 15_000,
          fileParallelism: false,
          globals: true,

          env: {
            NODE_ENV: 'test',
            PORT: '3002',
            ACTIVE_GATEWAY: 'razorpay',
            REDIS_URL: 'redis://localhost:6379',
            WEBHOOK_RELAY_URL: 'http://localhost:4000/webhook',
            RAZORPAY_KEY_ID: 'rzp_test_mockKeyId00001',
            RAZORPAY_KEY_SECRET: 'mockSecret00001',
            RAZORPAY_WEBHOOK_SECRET: 'mockWebhookSecret001',
            RAZORPAY_BASE_URL: 'http://localhost:9090',
          },
        },
      },
    ],

    // ── Coverage ─────────────────────────────────────────────────────────────
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/server.ts',
        'src/types/**',
        'src/**/*.d.ts',
        'src/views/**',
        'src/bootstrap.ts',
        'src/utils/logger.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
      reporter: ['text', 'lcov', 'html'],
    },
  },
});
