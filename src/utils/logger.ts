// logger.ts
//
// Rules (Steps.md §3 — Utils Layer):
//   - No imports from config, store, services, or errors
//
// The logger deliberately does NOT import config. It used to, and that single
// edge closed a module cycle:
//
//   config/index.ts → config/env.schema.ts → gateways/gateway.registry.ts
//     → gateways/paytm/paytm.plugin.ts → utils/logger.ts → config/index.ts
//
// app.ts imports gateway.registry before config, so ESM evaluated the registry
// first; its import chain reached back into env.schema, which reads
// `supportedGateways` from the registry at module-eval time — while the
// registry's own body had not yet run. The result was a temporal-dead-zone
// ReferenceError at startup.
//
// Reading process.env here instead would only trade one rule for another:
// contributorguide §14 reserves process.env for config/env.schema.ts and
// config/index.ts. So the dependency is inverted rather than relocated —
// the composition root (server.ts) pushes settings in via configureLogger().
//
// Until that call happens the logger runs on safe production defaults, so
// module-scope `createContextLogger(...)` at import time keeps working.

import winston from 'winston';

// Settings the logger needs, supplied by the caller rather than imported.
// Mirrors the shape of `config` without depending on it.
//
// env / version / format are optional so a caller that knows only the two
// flags still gets a working logger. Every call re-applies all settings, so an
// omitted field resets to its default rather than keeping a previous value.
export interface LoggerSettings {
  isTest: boolean;
  isDevelopment: boolean;
  // Stamped on every record so Loki labels derive from the log itself
  // (ADR 003 §5 Phase 1a).
  env?: string;
  version?: string;
  // Explicit output format. Omitted → pretty in development, JSON otherwise.
  format?: 'json' | 'pretty';
}

// Service name on every record. A constant rather than a setting: it names
// this codebase, not a deployment.
const SERVICE_NAME = 'checkoutos';

// Base fields added to every record via defaultMeta. The pretty format strips
// them so development output stays readable.
const BASE_FIELDS: ReadonlySet<string> = new Set(['service', 'env', 'version']);

type ContextLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
};

const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ level: true }),
  winston.format.printf(
    ({ timestamp, level, message, ...meta }: winston.Logform.TransformableInfo): string => {
      const fields = Object.fromEntries(
        Object.entries(meta).filter(([key]): boolean => !BASE_FIELDS.has(key)),
      );
      const metaStr = Object.keys(fields).length > 0 ? '  ' + JSON.stringify(fields, null, 0) : '';
      return `${timestamp} [${level}] ${message}${metaStr}`;
    },
  ),
);

//   json format for production
// {"timestamp":"2024-01-15T10:30:00.000Z","level":"info","message":"[redis] Connected"}

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Level for a given set of settings. Kept as one function so the startup path
// and the defaults below cannot drift apart.
function resolveLevel(settings: LoggerSettings): string {
  return settings.isTest ? 'silent' : settings.isDevelopment ? 'debug' : 'info';
}

// Defaults applied at import time, before configureLogger() runs. Production
// settings are the safe choice: structured JSON, info level, nothing silenced.
// A process that never calls configureLogger() still logs, just without
// development formatting.
const DEFAULT_SETTINGS: LoggerSettings = { isTest: false, isDevelopment: false };

function resolveFormat(settings: LoggerSettings): winston.Logform.Format {
  const format = settings.format ?? (settings.isDevelopment ? 'pretty' : 'json');
  return format === 'pretty' ? devFormat : prodFormat;
}

function resolveDefaultMeta(settings: LoggerSettings): Record<string, string> {
  return {
    service: SERVICE_NAME,
    ...(settings.env !== undefined && { env: settings.env }),
    ...(settings.version !== undefined && { version: settings.version }),
  };
}

export const logger = winston.createLogger({
  // Individual tests can enable logging by adjusting the level.
  level: resolveLevel(DEFAULT_SETTINGS),

  defaultMeta: resolveDefaultMeta(DEFAULT_SETTINGS),

  format: prodFormat,

  transports: [
    // Always log to stdout — in containers, stdout is collected by the
    // orchestrator (Docker, Kubernetes) and forwarded to the log aggregator.
    new winston.transports.Console({
      silent: DEFAULT_SETTINGS.isTest,
    }),
  ],

  // Do not exit on handled exceptions — let the error middleware decide.
  exitOnError: false,
});

// Apply runtime settings to the logger. Called once from the composition root
// (server.ts) after config has been validated — that is the only layer allowed
// to read config and hand it down, which keeps this module dependency-free.
//
// Safe to call more than once; each call fully re-applies level, format and
// transport silencing rather than merging.
export function configureLogger(settings: LoggerSettings): void {
  logger.level = resolveLevel(settings);
  logger.format = resolveFormat(settings);
  logger.defaultMeta = resolveDefaultMeta(settings);

  for (const transport of logger.transports) {
    transport.silent = settings.isTest;
  }
}

export function createContextLogger(context: string): ContextLogger {
  return {
    info: (message: string, meta?: Record<string, unknown>): void => {
      logger.info(`[${context}] ${message}`, meta);
    },

    warn: (message: string, meta?: Record<string, unknown>): void => {
      logger.warn(`[${context}] ${message}`, meta);
    },

    error: (message: string, meta?: Record<string, unknown>): void => {
      logger.error(`[${context}] ${message}`, meta);
    },

    debug: (message: string, meta?: Record<string, unknown>): void => {
      logger.debug(`[${context}] ${message}`, meta);
    },
  };
}
