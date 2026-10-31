// env.schema.ts
//
// Rules:
// - All numeric env vars are coerced from string → number via Zod
// - Gateway credentials are conditionally required based on active gateway
// - Sensitive values like secrets and keys are never logged
// - Only this file and config/index.ts ever read process.env
//   (sole exception: config/runtime.ts, the telemetry bootstrap's early read)

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

  // ── Observability (ADR 003) ────────────────────────────────────────────────
  // The telemetry bootstrap reads these early through config/runtime.ts,
  // before this schema has run. Validation here is still what fails startup.

  // Stamped onto every log record and the OTel resource (service.version).
  // Set from a Docker build arg in production.
  APP_VERSION: z.string().min(1, 'APP_VERSION must not be empty').default('0.0.0'),

  // Unset → pretty in development, JSON everywhere else.
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),

  // Internal metrics listener — never the public API port.
  METRICS_PORT: z.coerce
    .number()
    .int()
    .min(1024, 'METRICS_PORT must be >= 1024')
    .max(65535, 'METRICS_PORT must be <= 65535')
    .default(9464),

  // Unset → no auth on /metrics (network isolation assumed).
  METRICS_AUTH_TOKEN: z.string().min(1, 'METRICS_AUTH_TOKEN must not be empty when set').optional(),

  // Share of NON-error traces exported when an OTLP traces endpoint is set;
  // traces containing an error are always exported. Read early by
  // config/runtime.ts — validated here so a bad value still fails startup.
  TRACE_SAMPLE_RATIO: z.coerce
    .number()
    .min(0, 'TRACE_SAMPLE_RATIO must be between 0 and 1')
    .max(1, 'TRACE_SAMPLE_RATIO must be between 0 and 1')
    .default(0.1),

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

  // Paytm website name — identifies the checkout environment.
  // Sandbox:    WEBSTAGING  (default when this var is absent)
  // Production: DEFAULT     (or a custom name assigned by Paytm)
  // Hardcoding 'WEBSTAGING' in production causes payment failures.
  PAYTM_WEBSITE_NAME: z.string().optional(),

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

  // Two listeners on one port is EADDRINUSE at boot — catch it as config.
  if (env.METRICS_PORT === env.PORT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['METRICS_PORT'],
      message: `METRICS_PORT must differ from PORT (both are ${env.PORT})`,
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;
