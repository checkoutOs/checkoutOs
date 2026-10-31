// tests/unit/utils/logger.test.ts
// Unit tests for the logger: configuration inversion and record shape.
//
// No mock — vitest.setup.unit.ts configures the REAL logger as silent, and
// these tests reconfigure it and capture output through a stream transport.
//
// Business invariants protected:
//   - The logger imports nothing from config or errors (Steps.md §3: utils
//     have zero dependencies on config/store/services/errors). The config
//     edge previously closed a startup import cycle and crashed the process
//     with a TDZ ReferenceError before any request could be served.
//   - configureLogger() applies level, silencing, format and base fields, and
//     re-applies rather than merges
//   - Output is JSON unless stdout is a terminal or LOG_FORMAT=pretty — so
//     anything shipped to Loki is parseable (ADR 003 §5 Phase 1a)
//   - Records are { ...fields, event, component }; a field can never replace
//     the event name, and Errors in fields keep their stack, code and details

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PassThrough } from 'stream';
import winston from 'winston';
import {
  logger,
  configureLogger,
  createContextLogger,
  type LogFields,
} from '../../../src/utils/logger';

// Source text with comments stripped. The rules below constrain what the module
// DOES, not what it explains — and this file's header discusses both `config`
// and `process.env` at length.
function loggerCode(): string {
  return readFileSync(resolve(__dirname, '../../../src/utils/logger.ts'), 'utf-8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

// Run fn with the logger writing to an in-memory stream instead of stdout,
// and return the lines it produced.
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => lines.push(chunk.toString().trim()));
  const original = [...logger.transports];
  const sink = new winston.transports.Stream({ stream });

  logger.clear();
  logger.add(sink);
  try {
    fn();
  } finally {
    logger.remove(sink);
    for (const transport of original) logger.add(transport);
  }
  return lines;
}

function captureJson(fn: () => void): Record<string, unknown>[] {
  return capture(fn).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const LIVE_JSON = { isTest: false, isDevelopment: false, format: 'json' } as const;

afterEach(() => {
  // Back to the setup file's silent test settings.
  configureLogger({ isTest: true, isDevelopment: false });
});

// ---------------------------------------------------------------------------
// The dependency rule itself
// ---------------------------------------------------------------------------

describe('logger — layer dependency rule', () => {
  const imports = (): string =>
    loggerCode()
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n');

  it('does not import config', () => {
    // Asserted on the source text rather than behaviour: the violation is a
    // static import edge, and a runtime assertion cannot observe one.
    expect(imports()).not.toMatch(/from\s+'\.\.\/config/);
  });

  it('does not import errors', () => {
    // AppError's code/details are serialised by shape for exactly this reason.
    expect(imports()).not.toMatch(/from\s+'\.\.\/errors/);
  });

  it('makes no ambient reads of process.env or process.stdout', () => {
    // contributorguide §14 reserves process.env for config; TTY detection is
    // supplied by the caller (isTTY) for the same reason.
    expect(loggerCode()).not.toMatch(/process\.(env|stdout)/);
  });
});

// ---------------------------------------------------------------------------
// configureLogger — level and silencing
// ---------------------------------------------------------------------------

describe('configureLogger — level and silencing', () => {
  it('uses debug in development', () => {
    configureLogger({ isTest: false, isDevelopment: true });

    expect(logger.level).toBe('debug');
  });

  it('uses info otherwise', () => {
    configureLogger({ isTest: false, isDevelopment: false });

    expect(logger.level).toBe('info');
  });

  it('silences the logger under test settings without a fake level', () => {
    // 'silent' is not a winston npm level; silencing is logger.silent.
    configureLogger({ isTest: true, isDevelopment: false });

    expect(logger.silent).toBe(true);
    expect(logger.level).toBe('info');
    expect(capture(() => createContextLogger('probe').error('probe.event'))).toEqual([]);
  });

  it('re-applies rather than merges on a second call', () => {
    configureLogger({ isTest: true, isDevelopment: true });
    configureLogger({ isTest: false, isDevelopment: false });

    expect(logger.level).toBe('info');
    expect(logger.silent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// configureLogger — base fields
// ---------------------------------------------------------------------------

describe('configureLogger — base fields', () => {
  it('stamps service, env and version on every record', () => {
    configureLogger({ ...LIVE_JSON, env: 'production', version: '1.2.3' });

    const [record] = captureJson(() => createContextLogger('probe').info('probe.event'));

    expect(record).toMatchObject({ service: 'checkoutos', env: 'production', version: '1.2.3' });
  });

  it('accepts a service override', () => {
    configureLogger({ ...LIVE_JSON, service: 'checkoutos-worker' });

    expect(logger.defaultMeta).toEqual({ service: 'checkoutos-worker' });
  });

  it('resets env and version when a later call omits them', () => {
    configureLogger({ ...LIVE_JSON, env: 'production', version: '1.2.3' });
    configureLogger({ isTest: false, isDevelopment: false });

    expect(logger.defaultMeta).toEqual({ service: 'checkoutos' });
  });
});

// ---------------------------------------------------------------------------
// configureLogger — output format
// ---------------------------------------------------------------------------

describe('configureLogger — output format', () => {
  const isJson = (line: string | undefined): boolean => {
    try {
      JSON.parse(line ?? '');
      return true;
    } catch {
      return false;
    }
  };
  const emitOne = (): string | undefined =>
    capture(() => createContextLogger('probe').info('probe.event'))[0];

  it('defaults to JSON when stdout is not a terminal — even in development', () => {
    // docker compose, CI, Alloy: none are TTYs, all must ship parseable lines.
    configureLogger({ isTest: false, isDevelopment: true, isTTY: false });

    expect(isJson(emitOne())).toBe(true);
  });

  it('defaults to pretty on a terminal', () => {
    configureLogger({ isTest: false, isDevelopment: true, isTTY: true });

    expect(isJson(emitOne())).toBe(false);
  });

  it('defaults to JSON when the caller does not say', () => {
    configureLogger({ isTest: false, isDevelopment: true });

    expect(isJson(emitOne())).toBe(true);
  });

  it('honours LOG_FORMAT=json on a terminal', () => {
    configureLogger({ isTest: false, isDevelopment: true, isTTY: true, format: 'json' });

    expect(isJson(emitOne())).toBe(true);
  });

  it('honours LOG_FORMAT=pretty off a terminal', () => {
    configureLogger({ isTest: false, isDevelopment: false, isTTY: false, format: 'pretty' });

    expect(isJson(emitOne())).toBe(false);
  });

  it('pretty output shows the component and hides base fields and the duplicate event', () => {
    configureLogger({ ...LIVE_JSON, format: 'pretty', env: 'development', version: '1.2.3' });

    const [line] = capture(() =>
      createContextLogger('payment-service').info('payment.created', { chkId: 'chk_probe' }),
    );

    expect(line).toContain('[payment-service] payment.created');
    expect(line).toContain('chk_probe');
    expect(line).not.toContain('checkoutos');
    expect(line).not.toContain('1.2.3');
    expect(line).not.toContain('"event"');
  });
});

// ---------------------------------------------------------------------------
// createContextLogger — record shape
// ---------------------------------------------------------------------------

describe('createContextLogger — record shape', () => {
  it('writes { ...fields, event, component } with the event as the message', () => {
    configureLogger(LIVE_JSON);

    const [record] = captureJson(() =>
      createContextLogger('payment-service').info('payment.created', { chkId: 'chk_1' }),
    );

    expect(record).toMatchObject({
      level: 'info',
      event: 'payment.created',
      message: 'payment.created',
      component: 'payment-service',
      chkId: 'chk_1',
    });
  });

  it('does not prefix the message with the component', () => {
    configureLogger(LIVE_JSON);

    const [record] = captureJson(() => createContextLogger('redis').info('redis.connected'));

    expect(record?.['message']).toBe('redis.connected');
  });

  it('never lets a field replace the event or component', () => {
    // The type forbids these keys; this guards the runtime spread order for
    // callers that bypass the type (e.g. spreading an untyped object).
    configureLogger(LIVE_JSON);
    const sneaky = { event: 'gateway.native', component: 'other' } as unknown as LogFields;

    const [record] = captureJson(() =>
      createContextLogger('webhook-service').info('webhook.received', sneaky),
    );

    expect(record).toMatchObject({ event: 'webhook.received', component: 'webhook-service' });
  });

  it('emits at every level', () => {
    configureLogger({ ...LIVE_JSON, isDevelopment: true });
    const log = createContextLogger('probe');

    const levels = captureJson(() => {
      log.debug('probe.debug');
      log.info('probe.info');
      log.warn('probe.warn');
      log.error('probe.error');
    }).map((record) => record['level']);

    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });
});

// ---------------------------------------------------------------------------
// Error serialisation
// ---------------------------------------------------------------------------

describe('error serialisation', () => {
  class FakeAppError extends Error {
    readonly code = 'PAYMENT_NOT_FOUND';
    readonly details = { chkId: 'chk_1' };
  }

  it('expands an Error passed as a field instead of writing {}', () => {
    configureLogger(LIVE_JSON);

    const [record] = captureJson(() =>
      createContextLogger('probe').error('probe.failed', { error: new Error('boom') }),
    );

    expect(record?.['error']).toMatchObject({ name: 'Error', message: 'boom' });
    expect(String((record?.['error'] as { stack: unknown }).stack)).toContain('boom');
  });

  it('keeps AppError code and details', () => {
    configureLogger(LIVE_JSON);

    const [record] = captureJson(() =>
      createContextLogger('probe').error('probe.failed', {
        error: new FakeAppError('Payment not found'),
      }),
    );

    expect(record?.['error']).toMatchObject({
      message: 'Payment not found',
      code: 'PAYMENT_NOT_FOUND',
      details: { chkId: 'chk_1' },
    });
  });

  it('expands Errors in pretty output too', () => {
    configureLogger({ ...LIVE_JSON, format: 'pretty' });

    const [line] = capture(() =>
      createContextLogger('probe').error('probe.failed', { error: new Error('boom') }),
    );

    expect(line).toContain('"message":"boom"');
  });
});
