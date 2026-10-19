// tests/unit/lint/log-events.test.ts
// Fixture test for the log event-name lint rule (ADR 003 §5 Phase 1a).
//
// The rule in eslint.config.js is only as good as LOG_EVENT_PATTERN. A pattern
// that is too strict fails the codebase; one that is too loose — an unescaped
// `.` matches any character — silently accepts `orderId.amount_mismatch` and
// `connected`. Both happened while writing it. This test pins the pattern to
// real data:
//   - every event name in scripts/event-map.json and in src/ is accepted
//   - every pre-migration prose name is rejected
//   - the codemod and the lint rule use the same pattern

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { LOG_EVENT_PATTERN } from '../../../eslint.config.js';

const ROOT = resolve(__dirname, '../../..');
const eventMap = JSON.parse(readFileSync(join(ROOT, 'scripts/event-map.json'), 'utf-8')) as Record<
  string,
  string
>;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function eventsInSource(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const code = readFileSync(file, 'utf-8');
    for (const match of code.matchAll(/\blog(?:\.\w+|\[\w+\])\(\s*'([^']*)'/g)) {
      names.add(match[1]!);
    }
  }
  return [...names];
}

describe('LOG_EVENT_PATTERN', () => {
  it('accepts every migrated event name', () => {
    const rejected = Object.values(eventMap).filter((name) => !LOG_EVENT_PATTERN.test(name));

    expect(rejected).toEqual([]);
  });

  it('accepts every event name currently in src/', () => {
    const names = eventsInSource();
    const rejected = names.filter((name) => !LOG_EVENT_PATTERN.test(name));

    expect(names.length).toBeGreaterThan(50);
    expect(rejected).toEqual([]);
  });

  it('rejects every pre-migration name that was renamed', () => {
    const renamed = Object.entries(eventMap)
      .filter(([from, to]) => from !== to)
      .map(([from]) => from);
    const accepted = renamed.filter((name) => LOG_EVENT_PATTERN.test(name));

    expect(renamed.length).toBeGreaterThan(50);
    expect(accepted).toEqual([]);
  });

  it.each([
    ['prose', 'Payment created'],
    ['uppercase', 'orderId.amount_mismatch'],
    ['no dot', 'connected'],
    ['empty segment', 'payment..created'],
    ['leading dot', '.payment.created'],
    ['trailing dot', 'payment.created.'],
    ['leading underscore', '_payment.created'],
    ['double underscore', 'payment.created__twice'],
    ['hyphen', 'payment.created-now'],
    ['digit first', '1payment.created'],
  ])('rejects %s: %j', (_label, name) => {
    expect(LOG_EVENT_PATTERN.test(name)).toBe(false);
  });

  it.each([
    'payment.created',
    'idempotency.race_condition_retry_exhausted',
    'http.error.after_headers_sent',
    'redis.ping_ok',
  ])('accepts %j', (name) => {
    expect(LOG_EVENT_PATTERN.test(name)).toBe(true);
  });

  it('is the same pattern the codemod uses', () => {
    const script = readFileSync(join(ROOT, 'scripts/log-events.mjs'), 'utf-8');
    const declared = /^const PATTERN = \/(.+)\/;$/m.exec(script)?.[1];

    expect(declared).toBe(LOG_EVENT_PATTERN.source);
  });
});
