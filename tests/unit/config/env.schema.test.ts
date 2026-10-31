// tests/unit/config/env.schema.test.ts
// Validation of the observability variables added by ADR 003.
//
// Business invariants protected:
//   - Defaults keep existing deployments booting with no new variables set
//   - Invalid values fail startup (fail fast) rather than reaching the
//     telemetry bootstrap's lenient early read in config/runtime.ts
//   - The metrics listener can never be configured onto the API port

import { describe, it, expect } from 'vitest';
import { EnvSchema } from '../../../src/config/env.schema';

const BASE = {
  NODE_ENV: 'test',
  PORT: '3001',
  ACTIVE_GATEWAY: 'razorpay',
  REDIS_URL: 'redis://localhost:6379',
  WEBHOOK_RELAY_URL: 'http://localhost:4000/webhook',
  RAZORPAY_KEY_ID: 'rzp_test_mockKeyId00001',
  RAZORPAY_KEY_SECRET: 'mockSecret00001',
  RAZORPAY_WEBHOOK_SECRET: 'mockWebhookSecret001',
};

function issuePaths(env: Record<string, string>): string[] {
  const result = EnvSchema.safeParse(env);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('EnvSchema — observability variables', () => {
  it('defaults every new variable', () => {
    const result = EnvSchema.parse(BASE);

    expect(result.APP_VERSION).toBe('0.0.0');
    expect(result.LOG_FORMAT).toBeUndefined();
    expect(result.METRICS_PORT).toBe(9464);
    expect(result.METRICS_AUTH_TOKEN).toBeUndefined();
  });

  it('accepts valid values', () => {
    const result = EnvSchema.parse({
      ...BASE,
      APP_VERSION: '1.4.0',
      LOG_FORMAT: 'json',
      METRICS_PORT: '9500',
      METRICS_AUTH_TOKEN: 's3cret',
    });

    expect(result).toMatchObject({
      APP_VERSION: '1.4.0',
      LOG_FORMAT: 'json',
      METRICS_PORT: 9500,
      METRICS_AUTH_TOKEN: 's3cret',
    });
  });

  it('rejects an unknown LOG_FORMAT', () => {
    expect(issuePaths({ ...BASE, LOG_FORMAT: 'xml' })).toContain('LOG_FORMAT');
  });

  it.each(['80', '70000', 'abc'])('rejects METRICS_PORT %j', (value) => {
    expect(issuePaths({ ...BASE, METRICS_PORT: value })).toContain('METRICS_PORT');
  });

  it('rejects METRICS_PORT equal to PORT', () => {
    expect(issuePaths({ ...BASE, PORT: '9464', METRICS_PORT: '9464' })).toContain('METRICS_PORT');
  });

  it('rejects an empty METRICS_AUTH_TOKEN', () => {
    expect(issuePaths({ ...BASE, METRICS_AUTH_TOKEN: '' })).toContain('METRICS_AUTH_TOKEN');
  });
});
