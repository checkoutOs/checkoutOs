// env.schema.ts
//
// Rules:
// - All numeric env vars are coerced from string → number via Zod
// - Gateway credentials are conditionally required based on active gateway
// - Sensitive values like secrets and keys are never logged
// - Only this file and config/index.ts ever read process.env

import { z } from 'zod';
import {
  gatewayEnvDefinitions,
  supportedGateways,
  type SupportedGatewayName,
} from '../gateways/gateway.registry';

// GatewayName validation must stay in sync with the gateway registry.
const GatewayNameSchema = z.enum(
  supportedGateways as unknown as [SupportedGatewayName, ...SupportedGatewayName[]],
);

// Base schema
const BaseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  PORT: z.coerce
    .number()
    .int()
    .min(1024, 'PORT must be >= 1024')
    .max(65535, 'PORT must be <= 65535')
    .default(3000),

  // ── Gateway ────────────────────────────────────────────────────────────────

  ACTIVE_GATEWAY: GatewayNameSchema,

  // ── Redis ──────────────────────────────────────────────────────────────────

  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .refine((val): boolean => val.startsWith('redis://') || val.startsWith('rediss://'), {
      message: 'REDIS_URL must start with redis:// or rediss://',
    }),

  // ── Webhook relay ──────────────────────────────────────────────────────────

  WEBHOOK_RELAY_URL: z
    .string()
    .url('WEBHOOK_RELAY_URL must be a valid URL')
    .refine((val): boolean => val.startsWith('http://') || val.startsWith('https://'), {
      message: 'WEBHOOK_RELAY_URL must use http or https',
    }),

  // ── Razorpay credentials ───────────────────────────────────────────────────
  // Optional at schema level — conditionally required in superRefine below
  // when ACTIVE_GATEWAY=razorpay.

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Optional base URL override for Razorpay.
  // When set, the plugin uses this instead of the production Razorpay API URL.
  // Use this to point the plugin at your local mock server during development
  // or CI without changing any other code.
  //
  // Example values:
  //   production (default, omit this var): https://api.razorpay.com/v1
  //   local mock server:                   http://localhost:9090
  //
  // Note: MSW intercepts https://api.razorpay.com/v1 when the mock server is
  // running, so this override is only needed for direct HTTP isolation
  // (e.g. unit tests without MSW).
  RAZORPAY_BASE_URL: z.string().url('RAZORPAY_BASE_URL must be a valid URL if provided').optional(),

  // ── PayU credentials ───────────────────────────────────────────────────────

  PAYU_MERCHANT_KEY: z.string().optional(),
  PAYU_MERCHANT_SALT: z.string().optional(),
  PAYU_WEBHOOK_SECRET: z.string().optional(),

  // ── Paytm credentials ─────────────────────────────────────────────────────
  PAYTM_MERCHANT_ID: z.string().optional(),
  PAYTM_MERCHANT_KEY: z.string().optional(),
  PAYTM_WEBHOOK_SECRET: z.string().optional(),

  // Optional base URL override for Paytm.
  // When set, the plugin uses this instead of the production Paytm API URL.
  // Use this to point the plugin at your local mock server during development
  // or CI without changing any other code.
  //
  // Example values:
  //   production (default, omit this var): https://securegw.paytm.in
  //   local mock server:                   http://localhost:9091
  PAYTM_BASE_URL: z.string().url('PAYTM_BASE_URL must be a valid URL if provided').optional(),

  // ── Cashfree credentials ───────────────────────────────────────────────────

  CASHFREE_APP_ID: z.string().optional(),
  CASHFREE_SECRET_KEY: z.string().optional(),
  CASHFREE_WEBHOOK_SECRET: z.string().optional(),
});

export const EnvSchema = BaseEnvSchema.superRefine((env, ctx): void => {
  const requireField = (field: keyof typeof env, label: string): void => {
    const value = env[field];
    if (!value || (typeof value === 'string' && value.trim() === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${label} is required when ACTIVE_GATEWAY is "${env.ACTIVE_GATEWAY}"`,
      });
    }
  };

  const gatewayDef = gatewayEnvDefinitions[env.ACTIVE_GATEWAY];
  for (const envKey of gatewayDef.requiredEnvKeys) {
    // Registry guarantees envKey exists in BaseEnvSchema.
    requireField(envKey as keyof typeof env, envKey);
  }
});

export type Env = z.infer<typeof EnvSchema>;
