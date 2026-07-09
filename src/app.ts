// app.ts
// Builds and exports the Express application.
//
// Responsibilities:
//   1. Register global middleware (request logger)
//   2. Mount gateway-specific webhook body parsers BEFORE express.json()
//   3. Mount webhook router
//   4. Register express.json() for all other routes
//   5. Mount remaining routes
//   6. Register not-found handler (after routes)
//   7. Register error handler (last — always)
//
// Body parsing order matters:
//   express.raw()       ← Razorpay webhooks (JSON Buffer for HMAC)
//   express.urlencoded()← Paytm webhooks (NVP parsed object for CHECKSUMHASH)
//   webhookRouter       ← handles POST /webhooks/:gateway
//   express.json()      ← runs after, applies to all other routes

import express, { Application, Request, Response, NextFunction } from 'express';
import { registerGateways } from './gateways/gateway.registry';
import { connectRedis } from './store/redis.client';
import { config } from './config';
import type { SupportedGatewayName } from './gateways/gateway.registry';
import { errorHandler } from './middleware/error.middleware';
import { notFoundHandler } from './middleware/not-found.middleware';
import { createContextLogger } from './utils/logger';
import { checkoutRouter } from './routes/checkout.routes';
import { healthRouter, refundRouter, paymentRouter, webhookRouter } from './routes';

const log = createContextLogger('app');

// ---------------------------------------------------------------------------
// buildApp
// ---------------------------------------------------------------------------

export function buildApp(): Application {
  const app = express();

  // ── 1. Request logger ────────────────────────────────────────────────────
  // Must be first — captures all requests including those that fail early.
  // Log level follows HTTP status: 5xx → error, 4xx → warn, 2xx/3xx → info.
  app.use((req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();

    res.on('finish', (): void => {
      const latencyMs = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      log[level](`${req.method} ${req.path}`, {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        latencyMs,
      });
    });

    next();
  });

  // ── 2. Gateway-specific webhook body parsers — BEFORE express.json() ─────
  // Each gateway requires a different body format for webhook verification:
  //   Razorpay: application/json                  → raw Buffer for HMAC-SHA256
  //   Paytm:    application/x-www-form-urlencoded → parsed object for CHECKSUMHASH
  //
  // These MUST run before express.json() so the body stream is intact.

  // Razorpay webhooks: preserve raw Buffer for HMAC verification
  app.use('/webhooks/razorpay', express.raw({ type: 'application/json' }));

  // Paytm webhooks: parse URL-encoded NVP format for CHECKSUMHASH verification
  app.use('/webhooks/paytm', express.urlencoded({ extended: true }));

  // ── 3. Webhook router ────────────────────────────────────────────────────
  // Body parsing is handled above per gateway — the router only handles routing.
  app.use('/webhooks', webhookRouter);

  // ── 4. JSON body parser — for all remaining routes ───────────────────────
  app.use(express.json());

  // ── 5. Routes ─────────────────────────────────────────────────────────────
  app.use('/payments', paymentRouter);
  app.use('/refunds', refundRouter);
  app.use('/health', healthRouter);
  app.use('/checkout', checkoutRouter);

  // ── 6. Not-found handler ──────────────────────────────────────────────────
  // After all routes — fires only when no route matched.
  app.use(notFoundHandler);

  // ── 7. Error handler ──────────────────────────────────────────────────────
  // Must be last — Express identifies error middleware by 4-argument signature.
  app.use(errorHandler);

  return app;
}

// ---------------------------------------------------------------------------
// initialise
// ---------------------------------------------------------------------------
// Called once by server.ts before app.listen().
// Registers the active gateway plugin and connects Redis.
// Any failure exits the process — checkoutOs never starts half-initialised.

export async function initialise(): Promise<void> {
  registerGateways(
    process.env as Record<string, unknown>,
    config.gateway.active as SupportedGatewayName,
  );

  log.info('Gateway registered', { gateway: config.gateway.active });

  await connectRedis();

  log.info('Redis connected');
}
