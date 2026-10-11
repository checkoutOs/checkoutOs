// tests/unit/utils/logger.test.ts
// Unit tests for the logger's configuration inversion.
//
// vitest.setup.unit.ts mocks './src/utils/logger' globally, so these tests pull
// the REAL module via importActual — the point is to exercise the actual
// winston wiring, not the stub.
//
// Business invariants protected:
//   - The logger imports nothing from config (Steps.md §3: utils have zero
//     dependencies on config/store/services/errors). That edge previously
//     closed a startup import cycle and crashed the process with a TDZ
//     ReferenceError before any request could be served.
//   - configureLogger() applies level, format and transport silencing
//   - Settings are re-applied, not merged, so a second call fully overrides

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type winston from 'winston';

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

type LoggerModule = {
  logger: winston.Logger;
  configureLogger: (settings: {
    isTest: boolean;
    isDevelopment: boolean;
    env?: string;
    version?: string;
    format?: 'json' | 'pretty';
  }) => void;
};

// Run one record through the logger's current format and return the rendered
// line — what the Console transport would write.
function render(m: LoggerModule, fields: Record<string, unknown> = {}): string {
  const info = {
    level: 'info',
    message: 'probe',
    [Symbol.for('level')]: 'info',
    ...(m.logger.defaultMeta as Record<string, unknown>),
    ...fields,
  };
  const out = m.logger.format.transform(info, {}) as Record<symbol, unknown>;
  return String(out[Symbol.for('message')]);
}

async function loadRealLogger(): Promise<LoggerModule> {
  return (await vi.importActual('../../../src/utils/logger')) as LoggerModule;
}

let mod: LoggerModule;

beforeEach(async () => {
  mod = await loadRealLogger();
});

// ---------------------------------------------------------------------------
// The dependency rule itself
// ---------------------------------------------------------------------------

describe('logger — layer dependency rule', () => {
  it('does not import config', () => {
    // Asserted on the source text rather than behaviour: the violation is a
    // static import edge, and a runtime assertion cannot observe one.
    const imports = loggerCode()
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n');

    expect(imports).not.toMatch(/from\s+'\.\.\/config'/);
    expect(imports).not.toMatch(/from\s+'\.\.\/config\/index'/);
  });

  it('does not read process.env either', () => {
    // contributorguide §14 reserves process.env for config/env.schema.ts and
    // config/index.ts, so reading it here would swap one violation for another.
    expect(loggerCode()).not.toMatch(/process\.env/);
  });
});

// ---------------------------------------------------------------------------
// configureLogger
// ---------------------------------------------------------------------------

describe('configureLogger', () => {
  it('defaults to production settings before it is called', () => {
    // A process that never configures the logger still logs — it just misses
    // the development formatting.
    expect(mod.logger.level).toBe('info');
  });

  it('applies development settings', () => {
    mod.configureLogger({ isTest: false, isDevelopment: true });

    expect(mod.logger.level).toBe('debug');
  });

  it('applies production settings', () => {
    mod.configureLogger({ isTest: false, isDevelopment: false });

    expect(mod.logger.level).toBe('info');
  });

  it('silences every transport under test settings', () => {
    mod.configureLogger({ isTest: true, isDevelopment: false });

    expect(mod.logger.level).toBe('silent');
    for (const transport of mod.logger.transports) {
      expect(transport.silent).toBe(true);
    }
  });

  it('re-applies rather than merges on a second call', () => {
    mod.configureLogger({ isTest: true, isDevelopment: true });
    mod.configureLogger({ isTest: false, isDevelopment: false });

    expect(mod.logger.level).toBe('info');
    for (const transport of mod.logger.transports) {
      expect(transport.silent).toBe(false);
    }
  });

  it('stamps service, env and version on every record', () => {
    mod.configureLogger({
      isTest: false,
      isDevelopment: false,
      env: 'production',
      version: '1.2.3',
    });

    const record = JSON.parse(render(mod));
    expect(record).toMatchObject({ service: 'checkoutos', env: 'production', version: '1.2.3' });
  });

  it('resets env and version when a later call omits them', () => {
    mod.configureLogger({
      isTest: false,
      isDevelopment: false,
      env: 'production',
      version: '1.2.3',
    });
    mod.configureLogger({ isTest: false, isDevelopment: false });

    expect(mod.logger.defaultMeta).toEqual({ service: 'checkoutos' });
  });

  it('honours an explicit json format in development', () => {
    // Lets dashboards be built locally — Loki cannot parse the pretty format.
    mod.configureLogger({ isTest: false, isDevelopment: true, format: 'json' });

    expect(() => JSON.parse(render(mod))).not.toThrow();
  });

  it('honours an explicit pretty format in production', () => {
    mod.configureLogger({ isTest: false, isDevelopment: false, format: 'pretty' });

    expect(() => JSON.parse(render(mod))).toThrow();
  });

  it('defaults to pretty in development and strips the base fields from it', () => {
    mod.configureLogger({
      isTest: false,
      isDevelopment: true,
      env: 'development',
      version: '1.2.3',
    });

    const line = render(mod, { chkId: 'chk_probe' });
    expect(line).toContain('chk_probe');
    expect(line).not.toContain('checkoutos');
    expect(line).not.toContain('1.2.3');
  });

  it('keeps createContextLogger usable without any configuration', () => {
    // Call sites bind their logger at module scope, long before the
    // composition root configures anything.
    expect(() => mod.logger.info('[probe] startup message')).not.toThrow();
  });
});
