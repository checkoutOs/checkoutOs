// gateway.registry.ts
// Central registry of supported gateways.
//
// Single source of truth for:
//   - Supported gateway names          (consumed by env.schema.ts)
//   - Required env keys per gateway    (consumed by env.schema.ts)
//   - Default and override base URLs   (consumed by registerGateways)
//   - Credential extraction from env   (consumed by config/index.ts)
//   - Plugin instantiation             (registerGateways, called at startup)
//   - Active plugin access             (getActiveGateway, called by services)
//
// Rules:
//   - Never import from config/index.ts — circular dependency risk
//   - Never read process.env directly — always receive env as a parameter
//   - Adding a new gateway = registry change + plugin implementation only
//     (no changes to core business logic, services, or controllers)

import type { GatewayName } from '../types/payment.types';
import type { GatewayPlugin } from '../types/gateway.types';
import { GatewayUnavailableError } from '../errors/gateways.errors';
import { createRazorpayPlugin, type RazorpayConfig } from './razorpay/razorpay.plugin';

// ---------------------------------------------------------------------------
// Supported gateways
// ---------------------------------------------------------------------------
// consumed by env.schema.ts for ACTIVE_GATEWAY validation.
// Add new gateway names here when implementing new plugins.

export const supportedGateways = ['razorpay', 'payu', 'cashfree', 'paytm'] as const;
export type SupportedGatewayName = (typeof supportedGateways)[number];

// ---------------------------------------------------------------------------
// Gateway environment definitions
// ---------------------------------------------------------------------------
// Drives two things:
//   1. env.schema.ts superRefine — which credential keys are required per gateway
//   2. registerGateways — which env key holds the base URL override
//
// defaultBaseUrl: the production API URL, used when the override env var is absent
// baseUrlEnvKey:  optional env var name that overrides defaultBaseUrl
//                 set to http://localhost:9090 (or your MOCK_PORT) during dev/CI

export const gatewayEnvDefinitions = {
  razorpay: {
    requiredEnvKeys: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const,
    defaultBaseUrl: 'https://api.razorpay.com/v1',
    baseUrlEnvKey: 'RAZORPAY_BASE_URL',
  },
  payu: {
    requiredEnvKeys: ['PAYU_MERCHANT_KEY', 'PAYU_MERCHANT_SALT', 'PAYU_WEBHOOK_SECRET'] as const,
    defaultBaseUrl: 'https://api.payu.in',
    baseUrlEnvKey: 'PAYU_BASE_URL',
  },
  paytm: {
    requiredEnvKeys: ['PAYTM_MERCHANT_ID', 'PAYTM_MERCHANT_KEY'] as const,
    defaultBaseUrl: 'https://securegw.paytm.in',
    baseUrlEnvKey: 'PAYTM_BASE_URL',
  },
  cashfree: {
    requiredEnvKeys: ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY', 'CASHFREE_WEBHOOK_SECRET'] as const,
    defaultBaseUrl: 'https://api.cashfree.com',
    baseUrlEnvKey: 'CASHFREE_BASE_URL',
  },
} as const satisfies Record<
  SupportedGatewayName,
  {
    requiredEnvKeys: readonly string[];
    defaultBaseUrl: string;
    baseUrlEnvKey: string;
  }
>;

// ---------------------------------------------------------------------------
// Gateway credential env key mapping
// ---------------------------------------------------------------------------
// Maps logical credential field names → env var names per gateway.
// Consumed by buildActiveGatewayCredentials (called from config/index.ts).
// Keep field names in sync with each gateway's Credentials interface.

export const gatewayCredentialEnvKeys = {
  razorpay: {
    keyId: 'RAZORPAY_KEY_ID',
    keySecret: 'RAZORPAY_KEY_SECRET',
    webhookSecret: 'RAZORPAY_WEBHOOK_SECRET',
  },
  payu: {
    merchantKey: 'PAYU_MERCHANT_KEY',
    merchantSalt: 'PAYU_MERCHANT_SALT',
    webhookSecret: 'PAYU_WEBHOOK_SECRET',
  },
  paytm: {
    merchantId: 'PAYTM_MERCHANT_ID',
    merchantKey: 'PAYTM_MERCHANT_KEY',
    webhookSecret: 'PAYTM_WEBHOOK_SECRET',
  },

  cashfree: {
    appId: 'CASHFREE_APP_ID',
    secretKey: 'CASHFREE_SECRET_KEY',
    webhookSecret: 'CASHFREE_WEBHOOK_SECRET',
  },
} as const satisfies Record<SupportedGatewayName, Record<string, string>>;

// ---------------------------------------------------------------------------
// Runtime plugin map
// ---------------------------------------------------------------------------
// Populated once at startup by registerGateways().
// Services call getActiveGateway() — never access this map directly.

const gatewayPlugins: Partial<Record<SupportedGatewayName, GatewayPlugin>> = {};

// Tracks which gateway name was registered as active.
// Set by registerGateways() and read by getActiveGateway().
let activeGatewayName: SupportedGatewayName | null = null;

// ---------------------------------------------------------------------------
// registerGateways
// ---------------------------------------------------------------------------
// Called once at application startup (in app.ts / server.ts) after config
// has been validated.
//
// Reads credentials and baseUrl from the validated env object,
// instantiates the active gateway plugin, and registers it in the map.
//
// Receives the parsed env object — never reads process.env directly.

export function registerGateways(
  env: Record<string, unknown>,
  gateway: SupportedGatewayName,
): void {
  const def = gatewayEnvDefinitions[gateway];
  const credMap = gatewayCredentialEnvKeys[gateway] as Record<string, string>;

  // Resolve baseUrl: use override env var if set, otherwise use production default.
  const baseUrlOverride = env[def.baseUrlEnvKey];
  const baseUrl =
    typeof baseUrlOverride === 'string' && baseUrlOverride.trim() !== ''
      ? baseUrlOverride
      : def.defaultBaseUrl;

  // Extract credentials from env using the credential key map.
  const credentials: Record<string, string> = {};
  for (const [fieldName, envKey] of Object.entries(credMap)) {
    const value = env[envKey];
    // EnvSchema superRefine guarantees required keys are present and non-empty.
    credentials[fieldName] = typeof value === 'string' ? value : String(value ?? '');
  }

  // Instantiate the correct plugin based on gateway name.
  // Adding a new gateway: add a case here + implement its plugin.
  switch (gateway) {
    case 'razorpay': {
      const razorpayConfig: RazorpayConfig = {
        credentials: {
          keyId: credentials['keyId'] ?? '',
          keySecret: credentials['keySecret'] ?? '',
          webhookSecret: credentials['webhookSecret'] ?? '',
        },
        baseUrl,
      };
      gatewayPlugins['razorpay'] = createRazorpayPlugin(razorpayConfig);
      break;
    }

    case 'paytm': {
      // TODO: implement when Paytm plugin is ready
      // const paytmConfig: PaytmConfig = {
      //   credentials: {
      //     merchantId: credentials['merchantId'] ?? '',
      //     merchantKey: credentials['merchantKey'] ?? '',
      //     webhookSecret: credentials['webhookSecret'] ?? '',
      //   },
      //   baseUrl,
      // };
      // gatewayPlugins['paytm'] = createPaytmPlugin(paytmConfig);
      throw new Error(
        `Gateway "paytm" is listed as supported but its plugin is not yet implemented. ` +
          `Implement createPaytmPlugin in src/gateways/paytm/paytm.plugin.ts.`,
      );
    }

    case 'payu':
      // TODO: implement when PayU plugin is ready
      // gatewayPlugins['payu'] = createPayuPlugin({ credentials, baseUrl });
      throw new Error(
        `Gateway "payu" is listed as supported but its plugin is not yet implemented. ` +
          `Implement createPayuPlugin in src/gateways/payu/payu.plugin.ts.`,
      );

    case 'cashfree':
      // TODO: implement when Cashfree plugin is ready
      // gatewayPlugins['cashfree'] = createCashfreePlugin({ credentials, baseUrl });
      throw new Error(
        `Gateway "cashfree" is listed as supported but its plugin is not yet implemented. ` +
          `Implement createCashfreePlugin in src/gateways/cashfree/cashfree.plugin.ts.`,
      );

    default: {
      const _exhaustive: never = gateway;
      throw new Error(`Unhandled gateway in registerGateways: ${String(_exhaustive)}`);
    }
  }

  activeGatewayName = gateway;
}

// ---------------------------------------------------------------------------
// getActiveGateway
// ---------------------------------------------------------------------------
// Returns the registered GatewayPlugin for the active gateway.
// Called by services — they never instantiate plugins directly.
//
// Throws GatewayUnavailableError if registerGateways() was never called.
// This is a startup contract violation — the error will surface immediately
// on the first request rather than silently returning undefined.

export function getActiveGateway(): GatewayPlugin {
  if (activeGatewayName === null) {
    throw new GatewayUnavailableError(
      'unknown',
      'Gateway registry has not been initialized. ' +
        'Call registerGateways() during application startup before handling requests.',
    );
  }

  const plugin = gatewayPlugins[activeGatewayName];

  if (plugin === undefined) {
    throw new GatewayUnavailableError(
      activeGatewayName,
      `Plugin for gateway "${activeGatewayName}" was not found in the registry. ` +
        `This is a bug — registerGateways() should have populated it.`,
    );
  }

  return plugin;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------
// Consumed by env.schema.ts and other layers that need gateway name checks.

export function isSupportedGatewayName(name: GatewayName): name is SupportedGatewayName {
  return (supportedGateways as readonly string[]).includes(name);
}

export function getGatewayByName(name: GatewayName): SupportedGatewayName | null {
  return isSupportedGatewayName(name) ? name : null;
}

// ---------------------------------------------------------------------------
// buildActiveGatewayCredentials
// ---------------------------------------------------------------------------
// Consumed by config/index.ts to populate config.gateway.credentials.
// Returns a plain Record so config/index.ts stays decoupled from
// gateway-specific credential interface types.

export function buildActiveGatewayCredentials(
  env: Record<string, unknown>,
  gateway: SupportedGatewayName,
): Record<string, string> {
  const map = gatewayCredentialEnvKeys[gateway] as Record<string, string>;
  const out: Record<string, string> = {};

  for (const [fieldName, envKey] of Object.entries(map)) {
    const value = env[envKey];
    out[fieldName] = typeof value === 'string' ? value : String(value ?? '');
  }

  return out;
}
