// config/index.ts

//
// Fail fast behaviour

import { ZodError } from 'zod';
import { EnvSchema } from './env.schema';
import type { GatewayName } from '../types/payment.types';
import {
  buildActiveGatewayCredentials,
  type SupportedGatewayName,
} from '../gateways/gateway.registry';

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  const formatted = formatZodErrors(result.error);

  console.error('\n╔════════════════════════════════════════════════════════╗');
  console.error('║          checkoutOs — CONFIGURATION ERROR              ║');
  console.error('╚════════════════════════════════════════════════════════╝\n');
  console.error('The following environment variables are missing or invalid:\n');
  formatted.forEach((line): void => console.error(`  ✗ ${line}`));
  console.error('\nRefer to .env.example for required variables.\n');

  process.exit(1);
}

const env = result.data;

// Structured into logical groups so call sites are readable:
//   config.gateway.active     (not config.ACTIVE_GATEWAY)
//   config.redis.url          (not config.REDIS_URL)
//   config.razorpay.keyId     (not config.RAZORPAY_KEY_ID)

export const config = {
  // ── Runtime

  env: env.NODE_ENV,
  port: env.PORT,
  isDevelopment: env.NODE_ENV === 'development',
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  // ── Gateway

  gateway: {
    active: env.ACTIVE_GATEWAY as GatewayName,
    credentials: buildActiveGatewayCredentials(
      env as Record<string, unknown>,
      env.ACTIVE_GATEWAY as SupportedGatewayName,
    ),
  },

  // ── Redis

  redis: {
    url: env.REDIS_URL,
  },
  app: {
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  },

  // ── Webhook relay
  webhook: {
    relayUrl: env.WEBHOOK_RELAY_URL,
  },
} as const;

export type Config = typeof config;

function formatZodErrors(error: ZodError): string[] {
  return error.issues.map((issue): string => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
    return `${path}: ${issue.message}`;
  });
}
