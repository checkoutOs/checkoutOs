// tests/unit/config/runtime.test.ts
// Unit tests for the telemetry bootstrap's early runtime read.
//
// Business invariants protected (ADR 003 §5 Phase 0):
//   - runtime.ts has NO imports — that is what makes it safe to load before
//     the OTel SDK has patched winston / ioredis / express
//   - Only src/telemetry/ imports it — everything else reads `config`, so the
//     process.env exception stays confined to the one place that needs it
//   - loadRuntime() never throws; invalid values fall back to defaults and
//     env.schema.ts is what rejects them at startup

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { loadRuntime } from '../../../src/config/runtime';

const SRC = resolve(__dirname, '../../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function importLines(file: string): string[] {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line));
}

// ---------------------------------------------------------------------------
// Dependency rules
// ---------------------------------------------------------------------------

describe('runtime.ts — dependency rules', () => {
  it('has no imports', () => {
    expect(importLines(join(SRC, 'config/runtime.ts'))).toEqual([]);
  });

  it('is imported only from src/telemetry/', () => {
    const importers = sourceFiles(SRC)
      .filter((file) => importLines(file).some((line) => /config\/runtime'/.test(line)))
      .map((file) => relative(SRC, file).replace(/\\/g, '/'));

    for (const file of importers) {
      expect(file).toMatch(/^telemetry\//);
    }
  });

  it('is not imported by the logger', () => {
    // The logger takes its settings via configureLogger() — see logger.ts.
    const lines = importLines(join(SRC, 'utils/logger.ts')).join('\n');
    expect(lines).not.toMatch(/runtime/);
  });
});

// ---------------------------------------------------------------------------
// loadRuntime
// ---------------------------------------------------------------------------

describe('loadRuntime', () => {
  it('applies defaults to an empty environment', () => {
    expect(loadRuntime({})).toEqual({
      env: 'development',
      isTest: false,
      isDevelopment: true,
      isProduction: false,
      version: '0.0.0',
      metricsPort: 9464,
      metricsAuthToken: undefined,
    });
  });

  it('reads every supported variable', () => {
    const runtime = loadRuntime({
      NODE_ENV: 'production',
      APP_VERSION: '1.4.0',
      METRICS_PORT: '9500',
      METRICS_AUTH_TOKEN: 's3cret',
    });

    expect(runtime).toMatchObject({
      env: 'production',
      isProduction: true,
      isDevelopment: false,
      version: '1.4.0',
      metricsPort: 9500,
      metricsAuthToken: 's3cret',
    });
  });

  it('derives isTest from NODE_ENV=test', () => {
    expect(loadRuntime({ NODE_ENV: 'test' }).isTest).toBe(true);
  });

  it.each(['abc', '12.5', '-1', '0', ''])(
    'falls back to the default port for unparseable METRICS_PORT %j',
    (value) => {
      expect(loadRuntime({ METRICS_PORT: value }).metricsPort).toBe(9464);
    },
  );

  it('treats an empty METRICS_AUTH_TOKEN as unset', () => {
    // A blank bearer token must never become the required credential.
    expect(loadRuntime({ METRICS_AUTH_TOKEN: '' }).metricsAuthToken).toBeUndefined();
  });

  it('treats an empty APP_VERSION as unset', () => {
    expect(loadRuntime({ APP_VERSION: '' }).version).toBe('0.0.0');
  });

  it('reads process.env when called, not at import time', () => {
    // tracing.ts relies on this: it loads .env, THEN calls loadRuntime().
    const previous = process.env['APP_VERSION'];
    process.env['APP_VERSION'] = '9.9.9-probe';
    try {
      expect(loadRuntime().version).toBe('9.9.9-probe');
    } finally {
      if (previous === undefined) delete process.env['APP_VERSION'];
      else process.env['APP_VERSION'] = previous;
    }
  });
});
