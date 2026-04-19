// server.ts
// HTTP server entry point.
//
// Responsibilities:
//   1. Call initialise() — connects Redis, registers gateway plugin
//   2. Call buildApp() — creates the Express application
//   3. Call app.listen() — starts accepting traffic
//   4. Handle SIGTERM and SIGINT — graceful shutdown
//
// Graceful shutdown sequence:
//   1. server.close()     — stop accepting new connections; finish in-flight requests
//   2. disconnectRedis()  — close Redis connection cleanly
//   3. process.exit(0)    — clean exit
//
// Keeping startup errors fatal (process.exit(1)) ensures the container
// orchestrator (Docker, Kubernetes) detects the failure and restarts the pod.
import './bootstrap';

import { buildApp, initialise } from './app';
import { disconnectRedis } from './store/redis.client';
import { config } from './config';
import { createContextLogger } from './utils/logger';

console.log('ENV DEBUG:', {
  ACTIVE_GATEWAY: process.env.ACTIVE_GATEWAY,
  REDIS_URL: process.env.REDIS_URL,
  WEBHOOK_RELAY_URL: process.env.WEBHOOK_RELAY_URL,
});
const log = createContextLogger('server');

async function start(): Promise<void> {
  // --- Initialise dependencies before accepting traffic ---
  await initialise();

  // --- Build Express app ---
  const app = buildApp();

  // --- Start listening ---
  const server = app.listen(config.port, (): void => {
    log.info('checkoutOs server started', {
      port: config.port,
      env: config.env,
      gateway: config.gateway.active,
    });
  });

  // --- Graceful shutdown ---
  // Called on SIGTERM (Docker stop, Kubernetes pod termination)
  // and SIGINT (Ctrl+C in development).
  async function shutdown(signal: string): Promise<void> {
    log.info(`${signal} received — shutting down gracefully`);

    // Step 1: stop accepting new connections
    // Existing in-flight requests are allowed to complete.
    server.close(async (): Promise<void> => {
      log.info('HTTP server closed');

      // Step 2: disconnect Redis
      try {
        await disconnectRedis();
        log.info('Redis disconnected');
      } catch {
        log.warn('Redis disconnect error — forcing exit');
      }

      // Step 3: exit cleanly
      process.exit(0);
    });

    // Safety timeout — if server.close() doesn't complete within 10s,
    // force exit to avoid hanging indefinitely in a broken state.
    setTimeout((): void => {
      log.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000).unref(); // unref() so the timeout doesn't keep the event loop alive
  }

  process.on('SIGTERM', (): void => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', (): void => {
    void shutdown('SIGINT');
  });
}

// --- Start and handle fatal startup errors ---
start().catch((err: unknown): void => {
  const message = err instanceof Error ? err.message : String(err);
  // Use console.error here — logger may not be available if startup failed
  // before the logger was initialised.
  console.error('Fatal startup error:', message);
  process.exit(1);
});
