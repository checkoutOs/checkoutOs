// tests/helpers/app.helper.ts
// Shared test helper that creates a fully wired Express app for tests.
//
// Used by integration tests via supertest:
//   import { createTestApp } from '../helpers/app.helper';
//   const app = createTestApp();
//   const res = await request(app).get('/health');
//
// What this helper does:
//   - Calls buildApp() to get the real Express app with all middleware and routes
//   - Does NOT call initialise() — tests control their own Redis connection
//     and gateway registration independently
//   - Does NOT call app.listen() — supertest handles the port binding
//
// Gateway registration:
//   Integration tests that need the gateway registered should call
//   registerTestGateway() before the test. Tests that don't need the gateway
//   (e.g. testing 404 responses) can skip this.

import { Application } from 'express';
import { buildApp } from '../../src/app';
import { registerGateways } from '../../src/gateways/gateway.registry';
import type { SupportedGatewayName } from '../../src/gateways/gateway.registry';

let app: Application | null = null;

// ---------------------------------------------------------------------------
// createTestApp
// ---------------------------------------------------------------------------
// Returns the Express app singleton for tests.
// Subsequent calls return the same instance — app is built once per test run.

export function createTestApp(): Application {
  if (app === null) {
    app = buildApp();
  }
  return app;
}

// ---------------------------------------------------------------------------
// registerTestGateway
// ---------------------------------------------------------------------------
// Registers the Razorpay gateway plugin using test credentials.
// Safe to call multiple times — gateway.registry checks if already registered.
// Call this in beforeAll() for any test suite that exercises payment endpoints.

export function registerTestGateway(): void {
  try {
    registerGateways(process.env as Record<string, unknown>, 'razorpay' as SupportedGatewayName);
  } catch {
    // Already registered — safe to ignore in test environment
  }
}

// ---------------------------------------------------------------------------
// resetApp
// ---------------------------------------------------------------------------
// Clears the app singleton. Call in afterAll() if a test suite needs
// a fresh app instance (rare — most tests share the same app).

export function resetApp(): void {
  app = null;
}
