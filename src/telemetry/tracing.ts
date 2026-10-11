// tracing.ts
// Telemetry bootstrap — the composition root for src/telemetry/.
// See ADR 003 §5 Phase 0.
//
// Will be preloaded ahead of the app so the OTel SDK can patch modules before
// they load:
//   start: node --require ./dist/telemetry/tracing.js dist/server.js
//   dev:   tsx --import ./src/telemetry/register.mjs watch src/server.ts
// Not wired into package.json yet — that lands with the SDK, after the
// compiled-output fix (ADR 003 §5 Phase 0 Prerequisites, Blocker A).
//
// Rules:
//   - Imports ONLY dotenv, config/runtime.ts and @opentelemetry/* packages.
//     Anything else imported here loads before instrumentation and goes
//     unpatched — never import config/index.ts, the logger, or app code.
//   - The ONLY file in src/ that names an exporter (ADR 003 §2.4).
//   - Other telemetry modules receive `runtime` as a parameter from here
//     rather than calling loadRuntime() themselves.

import dotenv from 'dotenv';
import { loadRuntime, type Runtime } from '../config/runtime';

// ── 1. Load .env FIRST ──────────────────────────────────────────────────────
// bootstrap.ts also loads .env, but only once server.ts runs — after this
// file. Without this call, METRICS_PORT, METRICS_AUTH_TOKEN and APP_VERSION
// read as unset in development. dotenv is not an instrumented module, so
// loading it early is safe. It never overrides variables already set, so the
// second load in bootstrap.ts is a no-op for these keys.
//
// quiet: dotenv 17 otherwise prints a banner on every load.
dotenv.config({ quiet: true });

// ── 2. Read runtime facts — after dotenv, never before ──────────────────────
export const runtime: Runtime = loadRuntime();

// ── 3. OTel SDK ─────────────────────────────────────────────────────────────
// NodeSDK construction, metric readers, the :9464 listener and
// `if (!runtime.isTest) sdk.start()` land here in ADR 003 Phase 0.
