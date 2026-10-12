// tracing.ts

//
// Preloaded ahead of the app so the OTel SDK patches modules before they load://   start: node --require ./dist/telemetry/tracing.js dist/server.js
//   dev:   tsx watch --import ./src/telemetry/register.mjs src/server.ts
// server.ts also imports it first (via ./telemetry) for verify/shutdown; the
// module cache makes that the same instance, not a second SDK.
//
// Rules:
//   - Imports ONLY dotenv, config/runtime.ts, @opentelemetry/*, node built-ins
//     and sibling telemetry modules (which follow the same rule). Anything else
//     loads before instrumentation and goes unpatched — never import
//     config/index.ts, the logger, or app code. Enforced by
//     import/no-restricted-paths in eslint.config.js.
//   - The ONLY file in src/ that names an exporter (ADR 003 §2.4).
//   - Under NODE_ENV=test nothing is constructed: instrumentation constructors
//     patch modules immediately, and IORedisInstrumentation would race the
//     vitest ioredis mock.

import dotenv from 'dotenv';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AggregationType } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston';
import { loadRuntime, type Runtime } from '../config/runtime';
import { HTTP_SERVER_BUCKETS } from './buckets';
import { BUILD_INFO_METRIC, registerBuildInfo } from './metrics';
import { startMetricsServer, type MetricsServer } from './metrics.server';
import { buildMetricReaders, createPrometheusReader } from './readers';

const SERVICE_NAME = 'checkoutos';
const VERIFY_TIMEOUT_MS = 2_000;

// ── 1. Load .env FIRST ──────────────────────────────────────────────────────
// bootstrap.ts also loads .env, but only once server.ts runs — after this
// file. dotenv is not an instrumented module, so loading it early is safe; it
// never overrides variables already set. quiet: dotenv 17 prints a banner.
dotenv.config({ quiet: true });

// ── 2. Read runtime facts — after dotenv, never before ──────────────────────
export const runtime: Runtime = loadRuntime();

// ── No-op span processor ────────────────────────────────────────────────────
// still created, so trace_id exists for log correlation, but exported nowhere.
//
// Load-bearing: with no span processor, NodeSDK falls back to
// OTEL_TRACES_EXPORTER, whose default is OTLP on localhost:4318 — an export
// buffer and ECONNREFUSED retries inside the payment process. Do not "fix"
// that with OTEL_TRACES_EXPORTER=none instead: it can skip registering a
// tracer provider and strip trace_id from every log record.
class NoopSpanProcessor implements SpanProcessor {
  onStart(): void {
    // intentionally empty
  }
  onEnd(): void {
    // intentionally empty
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Load-order guard ────────────────────────────────────────────────────────
// Anything loaded before the instrumentations exist is never patched — e.g. an
// early winston means no log record ever carries trace_id, silently. Fail loud.
// require.cache is CJS-only (the production path); under tsx/ESM the guard is
// inert, which is why scripts/verify-telemetry.mjs also runs `npm run dev`.
function assertInstrumentedModulesNotLoaded(): void {
  if (typeof require === 'undefined') {
    return;
  }
  const early = new Set<string>();
  for (const path of Object.keys(require.cache)) {
    const match = /node_modules[\\/](winston|ioredis|express)[\\/]/.exec(path);
    if (match?.[1] !== undefined) {
      early.add(match[1]);
    }
  }
  if (early.size > 0) {
    throw new Error(
      `telemetry: loaded before instrumentation: ${[...early].join(', ')} — ` +
        'preload src/telemetry/tracing before any app code',
    );
  }
}

interface TelemetryHandle {
  sdk: NodeSDK;
  metricsServer: MetricsServer;
}

function startTelemetry(rt: Runtime): TelemetryHandle {
  assertInstrumentedModulesNotLoaded();

  // Stable HTTP semconv: emits http.server.request.duration in seconds with
  // http.route / http.request.method / http.response.status_code labels.
  // Must be set BEFORE HttpInstrumentation is constructed (it reads it then).
  // An operator-supplied value (e.g. http/dup during a migration) wins.
  process.env['OTEL_SEMCONV_STABILITY_OPT_IN'] ??= 'http';

  const prometheus = createPrometheusReader();

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: rt.version,
      // String literal on purpose: the typed constant lives in the unstable
      // `incubating` entry point, whose export paths move between releases.
      'deployment.environment.name': rt.env,
    }),

    spanProcessors: [new NoopSpanProcessor()],

    // Empty, not omitted: with no processors NodeSDK falls back to
    // OTEL_LOGS_EXPORTER, whose default is OTLP. Logs never transit the OTel
    // pipeline — Winston writes stdout, Alloy ships it (ADR 003 §3).
    logRecordProcessors: [],

    metricReaders: buildMetricReaders(rt, prometheus),

    // Buckets for an instrument we do not own — only a View can set them.
    views: [
      {
        instrumentName: 'http.server.request.duration',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: [...HTTP_SERVER_BUCKETS] },
        },
      },
    ],

    instrumentations: [
      new HttpInstrumentation({
        // Scrapes of our own /metrics listener are not API traffic.
        ignoreIncomingRequestHook: (req): boolean => req.socket.localPort === rt.metricsPort,
      }),
      new ExpressInstrumentation(),
      new IORedisInstrumentation(),
      // disableLogSending is REQUIRED: by default the instrumentation forwards
      // every record into the OTel Logs pipeline. Trace-context injection
      // (disableLogCorrelation, default false) is separate and stays on.
      new WinstonInstrumentation({ disableLogSending: true }),
    ],
  });

  sdk.start();

  // After start() — a meter obtained earlier is a permanent no-op.
  registerBuildInfo(rt.version);

  const metricsServer = startMetricsServer({
    port: rt.metricsPort,
    authToken: rt.metricsAuthToken,
    exporter: prometheus,
  });

  return { sdk, metricsServer };
}

const handle: TelemetryHandle | undefined = runtime.isTest ? undefined : startTelemetry(runtime);

// ---------------------------------------------------------------------------
// verifyTelemetry
// ---------------------------------------------------------------------------
// Boot check, called by server.ts before the app listens. Scrapes our own
// /metrics through the real listener (with the bearer token when set) and
// requires the build.info sentinel. Throws — and server.ts refuses to boot —
// when the listener failed to bind or instruments are not reaching the
// exposition. A payment service running with dead telemetry it believes is
// live is worse than one that refuses to start.

export async function verifyTelemetry(): Promise<void> {
  if (handle === undefined) {
    return;
  }

  await handle.metricsServer.ready;

  const token = runtime.metricsAuthToken;
  const res = await fetch(`http://127.0.0.1:${handle.metricsServer.port}/metrics`, {
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });
  const body = await res.text();

  if (res.status !== 200 || !body.includes(BUILD_INFO_METRIC)) {
    throw new Error(
      `telemetry: instruments are not reaching the exposition ` +
        `(GET /metrics → ${res.status}, ${BUILD_INFO_METRIC} ${body.includes(BUILD_INFO_METRIC) ? 'present' : 'missing'})`,
    );
  }
}

// ---------------------------------------------------------------------------
// shutdownTelemetry
// ---------------------------------------------------------------------------
// Called from server.ts graceful shutdown. Never throws — shutdown must
// proceed to process.exit regardless.

export async function shutdownTelemetry(): Promise<void> {
  if (handle === undefined) {
    return;
  }
  await Promise.allSettled([handle.metricsServer.stop(), handle.sdk.shutdown()]);
}
