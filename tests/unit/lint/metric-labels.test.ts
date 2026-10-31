// tests/unit/lint/metric-labels.test.ts
// Fixture test for the metric-label lint rule (ADR 003 §8.2), run through the
// real eslint.config.js.
//
// Business invariants protected:
//   - an object literal as metric attributes (.add/.record/.observe) is an
//     error in services, middleware and telemetry — the cardinality bug
//   - attributes from an attributes.ts builder pass
//   - Set.prototype.add and friends outside those folders stay legal
//   - the scoped block does not silently drop the log-event rule in those
//     folders (a later flat-config block REPLACES no-restricted-syntax)
//
// Type-aware parsing is switched off: lintText() on a virtual path is not part
// of tsconfig.eslint.json, and the rule under test is purely syntactic.

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { ESLint } from 'eslint';

const ROOT = resolve(__dirname, '../../..');

const eslint = new ESLint({
  cwd: ROOT,
  overrideConfig: {
    languageOptions: { parserOptions: { project: null, projectService: false } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'import/no-unresolved': 'off',
    },
  },
});

async function restricted(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, file) });
  return result!.messages
    .filter((message) => message.ruleId === 'no-restricted-syntax')
    .map((message) => message.message);
}

const DECLS = `
declare const counter: { add(value: number, attributes?: object): void };
declare const histogram: { record(value: number, attributes?: object): void };
declare const result: { observe(value: number, attributes?: object): void };
declare const gateway: string;
declare const chkId: string;
declare function gatewayLabels(...args: string[]): object;
`;

describe('metric label lint rule', () => {
  it.each([
    ['services', 'src/services/fixture.ts', 'counter.add(1, { gateway });'],
    ['middleware', 'src/middleware/fixture.ts', 'histogram.record(0.2, { chkId });'],
    ['telemetry', 'src/telemetry/fixture.ts', 'result.observe(1, { gateway: "razorpay" });'],
    ['spread', 'src/services/fixture.ts', 'counter.add(1, { ...gatewayLabels(gateway), chkId });'],
  ])('rejects an inline label object in %s', async (_label, file, call) => {
    const messages = await restricted(`${DECLS}\n${call}\n`, file);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/attributes\.ts builder/);
  });

  it('accepts attributes from a builder', async () => {
    const code = `${DECLS}
counter.add(1, gatewayLabels(gateway, 'createPayment', 'success'));
const labels = gatewayLabels(gateway, 'createPayment', 'success');
histogram.record(0.2, labels);
`;
    expect(await restricted(code, 'src/services/fixture.ts')).toEqual([]);
  });

  it('leaves Set.prototype.add alone outside the scoped folders', async () => {
    const code = 'const seen = new Set<object>();\nseen.add({ id: 1 });\n';

    expect(await restricted(code, 'src/utils/fixture.ts')).toEqual([]);
    expect(await restricted(code, 'src/store/fixture.ts')).toEqual([]);
  });

  it('keeps the log-event rule active in the scoped folders', async () => {
    const code = `declare const log: { info(event: string): void };\nlog.info('Payment created');\n`;

    for (const file of ['src/services/fixture.ts', 'src/utils/fixture.ts']) {
      const messages = await restricted(code, file);
      expect(messages, file).toHaveLength(1);
      expect(messages[0]).toMatch(/dotted lowercase/);
    }
  });
});
