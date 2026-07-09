// webhook.routes.ts
// POST /webhooks/:gateway
//
// Body parsing:
//   express.raw({ type: 'application/json' }) is applied ONLY to this router.
//   This router is mounted in app.ts BEFORE express.json() so the body stream
//   is intact when express.raw() runs. The handler receives req.body as a Buffer
//   which is passed directly to plugin.parseWebhookEvent() for HMAC verification.
//
//   If express.json() were to run first, the Buffer would be lost and signature
//   verification would always fail.

import { Router } from 'express';
import { receive } from '../controllers/webhooks.controllers';

export const webhookRouter = Router();

// Apply raw body parser before the handler — preserves Buffer for HMAC
webhookRouter.post('/:gateway', receive);
