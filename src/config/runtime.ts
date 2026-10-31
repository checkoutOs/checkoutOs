// runtime.ts
// Early, dependency-free read of the runtime facts the telemetry bootstrap
// needs. See ADR 003 §5 Phase 0.
//
// Why this exists alongside config/index.ts:
//   src/telemetry/tracing.ts is preloaded (--require / --import) so the OTel
//   SDK can patch winston, ioredis and express before anything loads them.
//   config/index.ts cannot be used there: it imports env.schema → the gateway
//   registry → the plugins → winston and axios, loading exactly the modules
//   that must not load before instrumentation. Nor can settings be pushed in
//   the way server.ts does for the logger — nothing runs before tracing.ts.
//
// Rules:
//   - NO imports. That absence is the invariant; it is what makes this file
//     safe to load first. tests/unit/config/runtime.test.ts enforces it.
//   - Imported ONLY by src/telemetry/. Everything else reads `config`.
//   - Not validated here. The same variables are validated by env.schema.ts
//     when config/index.ts loads, and an invalid value still fails startup
//     there. Unparseable values fall back to defaults so this read never throws.
//   - A function, not a module-level constant: process.env is read when it is
//     called, so the caller controls ordering (dotenv first — see tracing.ts).

export interface Runtime {
  env: string;
  isTest: boolean;
  isDevelopment: boolean;
  isProduction: boolean;
  version: string;
  metricsPort: number;
  metricsAuthToken: string | undefined;
  otlpMetricsEnabled: boolean;
  otlpTracesEnabled: boolean;
  traceSampleRatio: number;
}

const DEFAULT_METRICS_PORT = 9464;
// Share of non-error traces exported; error traces are always kept (ADR 003 §5 Phase 6).
const DEFAULT_TRACE_SAMPLE_RATIO = 0.1;

const isSet = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';

export function loadRuntime(source: Record<string, string | undefined> = process.env): Runtime {
  const env = source['NODE_ENV'] ?? 'development';

  const port = Number(source['METRICS_PORT']);
  const metricsPort =
    source['METRICS_PORT'] !== undefined && Number.isInteger(port) && port > 0
      ? port
      : DEFAULT_METRICS_PORT;

  // Empty string means "unset" — never require a blank bearer token.
  const token = source['METRICS_AUTH_TOKEN'];

  const otlpMetricsEnabled = [
    source['OTEL_EXPORTER_OTLP_ENDPOINT'],
    source['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
  ].some(isSet);

  // Traces leave the box only when an endpoint is configured — otherwise spans
  // are still created (trace_id on every log line) but exported nowhere.
  const otlpTracesEnabled = [
    source['OTEL_EXPORTER_OTLP_ENDPOINT'],
    source['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
  ].some(isSet);

  const ratio = Number(source['TRACE_SAMPLE_RATIO']);
  const traceSampleRatio =
    isSet(source['TRACE_SAMPLE_RATIO']) && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
      ? ratio
      : DEFAULT_TRACE_SAMPLE_RATIO;

  return {
    env,
    isTest: env === 'test',
    isDevelopment: env === 'development',
    isProduction: env === 'production',
    version: source['APP_VERSION'] || '0.0.0',
    metricsPort,
    metricsAuthToken: token !== undefined && token !== '' ? token : undefined,
    otlpMetricsEnabled,
    otlpTracesEnabled,
    traceSampleRatio,
  };
}
