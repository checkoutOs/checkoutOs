// logger.ts
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

export interface LoggerSettings {
  isTest: boolean;
  isDevelopment: boolean;
  // Stamped on every record so Loki labels derive from the log itself
  // (ADR 003 §5 Phase 1a).
  service?: string;
  env?: string;
  version?: string;
  // Explicit output format (LOG_FORMAT)
  format?: 'json' | 'pretty';

  isTTY?: boolean;
}

const DEFAULT_SERVICE = 'checkoutos';

// Base fields added to every record via defaultMeta. The pretty format strips
// them so development output stays readable.
const BASE_FIELDS: readonly string[] = ['service', 'env', 'version'];

// Structured fields for one record. The record shape is
// { ...fields, event, component } — the event name is also the message.
//
// Reserved keys are rejected at compile time:
//   - message:   winston CONCATENATES a meta `message` onto the record message,
//                so `http.error.operational` would ship as
//                `http.error.operational Payment not found`
//   - event, component: owned by the logger
//   - level:     owned by winston
// Rename the field instead (errorMessage, gatewayEvent, ...).
export type LogFields = Record<string, unknown> & {
  message?: never;
  event?: never;
  component?: never;
  level?: never;
};

// `event` is a dotted, lowercase, static name — payment.created,
// webhook.relay_failed. Enforced by a lint rule in eslint.config.js.
type LogMethod = (event: string, fields?: LogFields) => void;

type ContextLogger = {
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  debug: LogMethod;
};

// format.errors() only unwraps a top-level Error. An Error passed as a field
// serialises as {} — losing every stack trace a payments incident needs.
// Expand them. AppError's code/details are picked up by shape: this module
// may not import src/errors (see header).
const serializeErrors = winston.format((info): winston.Logform.TransformableInfo => {
  for (const [key, value] of Object.entries(info)) {
    if (value instanceof Error) {
      const extra = value as Error & { code?: unknown; details?: unknown };
      info[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
        ...(extra.code !== undefined && { code: extra.code }),
        ...(extra.details !== undefined && { details: extra.details }),
      };
    }
  }
  return info;
})();

// Fields the pretty format prints itself, or that duplicate the message.
const PRETTY_HIDDEN: ReadonlySet<string> = new Set([...BASE_FIELDS, 'event', 'component']);

const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  serializeErrors,
  winston.format.colorize({ level: true }),
  winston.format.printf(
    ({
      timestamp,
      level,
      message,
      component,
      ...meta
    }: winston.Logform.TransformableInfo): string => {
      const fields = Object.fromEntries(
        Object.entries(meta).filter(([key]): boolean => !PRETTY_HIDDEN.has(key)),
      );
      const metaStr = Object.keys(fields).length > 0 ? '  ' + JSON.stringify(fields, null, 0) : '';
      const where = component !== undefined ? ` [${String(component)}]` : '';
      return `${timestamp} [${level}]${where} ${message}${metaStr}`;
    },
  ),
);

// JSON for anything shipped:
// {"component":"payment-service","env":"production","event":"payment.created",
//  "level":"info","message":"payment.created","service":"checkoutos",...}
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  serializeErrors,
  winston.format.json(),
);

// Level for a given set of settings. Silencing is separate (logger.silent) —
// 'silent' is not a winston npm level.
function resolveLevel(settings: LoggerSettings): string {
  return settings.isDevelopment ? 'debug' : 'info';
}

// Defaults applied at import time, before configureLogger() runs. Production
// settings are the safe choice: structured JSON, info level, nothing silenced.
// A process that never calls configureLogger() still logs, just without
// development formatting.
const DEFAULT_SETTINGS: LoggerSettings = { isTest: false, isDevelopment: false };

function resolveFormat(settings: LoggerSettings): winston.Logform.Format {
  const format = settings.format ?? (settings.isTTY === true ? 'pretty' : 'json');
  return format === 'pretty' ? devFormat : prodFormat;
}

function resolveDefaultMeta(settings: LoggerSettings): Record<string, string> {
  return {
    service: settings.service ?? DEFAULT_SERVICE,
    ...(settings.env !== undefined && { env: settings.env }),
    ...(settings.version !== undefined && { version: settings.version }),
  };
}

export const logger = winston.createLogger({
  level: resolveLevel(DEFAULT_SETTINGS),

  silent: DEFAULT_SETTINGS.isTest,

  defaultMeta: resolveDefaultMeta(DEFAULT_SETTINGS),

  format: resolveFormat(DEFAULT_SETTINGS),

  transports: [
    // Always log to stdout — in containers, stdout is collected by the
    // orchestrator (Docker, Kubernetes) and forwarded to the log aggregator.
    new winston.transports.Console(),
  ],

  // Do not exit on handled exceptions — let the error middleware decide.
  exitOnError: false,
});

// Apply runtime settings to the logger. Called once from the composition root
// (server.ts) after config has been validated — that is the only layer allowed
// to read config and hand it down, which keeps this module dependency-free.
// The vitest setup files are the composition root for tests.
//
// Safe to call more than once; each call fully re-applies level, silencing,
// format and base fields rather than merging.
export function configureLogger(settings: LoggerSettings): void {
  logger.level = resolveLevel(settings);
  logger.silent = settings.isTest;
  logger.format = resolveFormat(settings);
  logger.defaultMeta = resolveDefaultMeta(settings);
}

// `component` names the emitting module (payment-service, redis, ...).
export function createContextLogger(component: string): ContextLogger {
  const emit = (
    level: 'info' | 'warn' | 'error' | 'debug',
    event: string,
    fields?: LogFields,
  ): void => {
    // Fields spread FIRST, so a caller can never overwrite the event name.
    // `event` is duplicated into `message`: Loki queries `event`, humans read
    // `message`.
    logger.log(level, event, { ...fields, event, component });
  };

  return {
    info: (event, fields): void => emit('info', event, fields),
    warn: (event, fields): void => emit('warn', event, fields),
    error: (event, fields): void => emit('error', event, fields),
    debug: (event, fields): void => emit('debug', event, fields),
  };
}
