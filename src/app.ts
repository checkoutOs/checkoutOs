// app.ts
// Builds and exports the Express application.
//
// Responsibilities:
//   1. Register global middleware (request logger)
//   2. Mount webhook router BEFORE express.json() — preserves raw Buffer for HMAC
//   3. Register express.json() for all other routes
//   4. Mount remaining routes
//   5. Register not-found handler (after routes)
//   6. Register error handler (last — always)
//
// Body parsing order matters:
//   webhookRouter   ← mounted first, uses express.raw() internally
//   express.json()  ← runs after webhook router, applies to all other routes
//
// server.ts imports buildApp() and initialise() — never calls listen() itself.
// Keeping app and server separate makes the app testable without binding a port.

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

  // ── 2. Webhook router — BEFORE express.json() ────────────────────────────
  // webhookRouter applies express.raw({ type: 'application/json' }) internally.
  // Mounting it here ensures the body stream is intact when raw() runs.
  // If express.json() ran first it would consume the stream and HMAC
  // verification would always fail with an incorrect signature.
  app.use('/webhooks', webhookRouter);

  // ── 3. JSON body parser — for all remaining routes ───────────────────────
  app.use(express.json());

  // ── 4. Routes ─────────────────────────────────────────────────────────────
  app.use('/payments', paymentRouter);
  app.use('/refunds', refundRouter);
  app.use('/health', healthRouter);
  app.use('/checkout', checkoutRouter);

  // ── 5. Not-found handler ──────────────────────────────────────────────────
  // After all routes — fires only when no route matched.
  app.use(notFoundHandler);

  // ── 6. Error handler ──────────────────────────────────────────────────────
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
