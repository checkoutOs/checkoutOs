// webhook.controller.ts
// Handles:
//   POST /webhooks/:gateway
//
// Critical body parsing note:
//   This route must use express.raw({ type: 'application/json' }) instead of
//   express.json(). The raw unparsed body is required for HMAC signature
//   verification in plugin.parseWebhookEvent(). If express.json() runs first,
//   the Buffer is lost and signature verification will always fail.
//
//   The raw body arrives as Buffer. It is passed directly to processWebhook()
//   which passes it to plugin.parseWebhookEvent() for verification and parsing.
//
//   This route-level body parser override is wired in routes/index.ts —
//   not in app.ts — so global express.json() middleware is unaffected.
//
// Response contract:
//   Always return 200 after signature verification passes.
//   Never return non-200 to the gateway after a verified webhook — this
//   causes Razorpay (and other gateways) to retry, leading to duplicate
//   state updates and relay calls.
//
//   GatewayInvalidSignatureError (401) is the one exception — an invalid
//   signature means the webhook is not from the gateway and must be rejected.

import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { processWebhook } from '../services/webhook.service';
import { createContextLogger } from '../utils/logger';
import type { GatewayName } from '../types/payment.types';

const log = createContextLogger('webhook-controller');

// ---------------------------------------------------------------------------
// POST /webhooks/:gateway
// ---------------------------------------------------------------------------
// Params: gateway — e.g. 'razorpay'
// Body: raw Buffer (express.raw middleware must be applied to this route)
// Headers: includes gateway signature header (e.g. x-razorpay-signature)
// Response: 200 — always, after successful signature verification
//
// Errors that propagate to middleware:
//   GatewayInvalidSignatureError → 401 (signature missing or invalid)
//   GatewayUnavailableError      → 503 (gateway plugin not available)

export const receive = asyncHandler(
  async (req: Request<{ gateway: string }>, res: Response): Promise<void> => {
    const gateway = req.params.gateway as GatewayName;

    const body: unknown = req.body;
    const headers = req.headers as Record<string, string | string[] | undefined>;

    log.debug('Webhook received', { gateway });

    try {
      await processWebhook(gateway, body, headers);
    } catch (err: unknown) {
      // Narrow error safely

      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'GATEWAY_INVALID_SIGNATURE'
      ) {
        throw err; // handled by error middleware → 401
      }

      log.error('Webhook processing failed', {
        gateway,
        error: err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error',
      });
    }

    res.status(200).json({ received: true });
  },
);
