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
//   1. server.close()       — stop accepting new connections; finish in-flight requests
//   2. disconnectRedis()    — close Redis connection cleanly
//   3. shutdownTelemetry()  — close the :9464 listener, flush the OTel SDK
//   4. process.exit(0)      — clean exit
//
// Keeping startup errors fatal (process.exit(1)) ensures the container
// orchestrator (Docker, Kubernetes) detects the failure and restarts the pod.
//

// MUST stay the first import — starts the OTel SDK before express, winston and
// ioredis load if it was not already preloaded (see src/telemetry/tracing.ts).
import { shutdownTelemetry, verifyTelemetry } from './telemetry';
import './bootstrap';

import { buildApp, initialise } from './app';
import { disconnectRedis } from './store/redis.client';
import { config } from './config';
import { configureLogger, createContextLogger } from './utils/logger';

const log = createContextLogger('server');

async function start(): Promise<void> {
  // --- Hand validated config to the logger ---
  // utils/logger.ts cannot import config without recreating the startup import
  // cycle (see the note at the top of that file), so the composition root
  // pushes the settings down. Runs before anything else in start() so all
  // startup logging uses the configured level and format.
  configureLogger({
    isTest: config.isTest,
    isDevelopment: config.isDevelopment,
    env: config.env,
    version: config.app.version,
    ...(config.log.format !== undefined && { format: config.log.format }),
    // No LOG_FORMAT → pretty only on a terminal; JSON for anything shipped.
    isTTY: process.stdout.isTTY === true,
  });

  // --- Refuse to boot with dead telemetry (ADR 003 §3.4) ---
  // Scrapes our own /metrics and requires the build.info sentinel. No-op under
  // NODE_ENV=test, where the SDK is never started.
  await verifyTelemetry();

  // --- Initialise dependencies before accepting traffic ---
  await initialise();

  // --- Build Express app ---
  const app = buildApp();

  // --- Start listening ---
  const server = app.listen(config.port, (): void => {
    log.info('server.started', {
      port: config.port,
      env: config.env,
      gateway: config.gateway.active,
    });
  });

  // --- Graceful shutdown ---
  // Called on SIGTERM (Docker stop, Kubernetes pod termination)
  // and SIGINT (Ctrl+C in development).
  async function shutdown(signal: string): Promise<void> {
    log.info('server.shutdown_started', { signal });

    // Step 1: stop accepting new connections
    // Existing in-flight requests are allowed to complete.
    server.close(async (): Promise<void> => {
      log.info('server.http_closed');

      // Step 2: disconnect Redis
      try {
        await disconnectRedis();
        log.info('server.redis_disconnected');
      } catch {
        log.warn('server.redis_disconnect_failed');
      }

      // Step 3: stop telemetry — never throws
      await shutdownTelemetry();
      log.info('server.telemetry_shutdown');

      // Step 4: exit cleanly
      process.exit(0);
    });

    // Safety timeout — if server.close() doesn't complete within 10s,
    // force exit to avoid hanging indefinitely in a broken state.
    setTimeout((): void => {
      log.error('server.shutdown_timeout');
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
