import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export const LOG_EVENT_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$/;

// Context loggers are always bound to `log` (const log = createContextLogger(...)).
const LOG_CALL = "CallExpression[callee.type='MemberExpression'][callee.object.name='log']";

const LOG_EVENT_RULES = [
  {
    selector: `${LOG_CALL} > :first-child:not(Literal)`,
    message:
      'Log event names must be static string literals (move dynamic values into fields) — see ADR 003 §5 Phase 1a',
  },
  {
    selector: `${LOG_CALL} > Literal:first-child:not([value=/${LOG_EVENT_PATTERN.source}/])`,
    message:
      'Log event must be dotted lowercase, e.g. payment.created or webhook.relay_failed — see ADR 003 §5 Phase 1a',
  },
];

// Metric labels come only from src/telemetry/attributes.ts builders (ADR 003
// §8.2): an object literal passed to .add/.record/.observe is the cardinality
// bug. Scoped to services, middleware and telemetry so Set.prototype.add
// elsewhere stays legal. Pinned by tests/unit/lint/metric-labels.test.ts.
export const METRIC_LABEL_FILES = [
  'src/services/**/*.ts',
  'src/middleware/**/*.ts',
  'src/telemetry/**/*.ts',
];

const METRIC_LABEL_RULE = {
  selector: 'CallExpression[callee.property.name=/^(add|record|observe)$/] > ObjectExpression',
  message:
    'Metric attributes must come from a src/telemetry/attributes.ts builder (gatewayLabels, webhookLabels, httpLabels) — see ADR 003 §8.2',
};

export default [
  {
    ignores: ['dist/**', 'coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.strict,

  /**
   * 🌐 Base TypeScript setup (applies to all TS files)
   */
  {
    files: ['**/*.ts'],

    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        sourceType: 'module',
      },
    },

    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: importPlugin,
    },

    rules: {
      /**
       * CORE SAFETY (keep global)
       */
      '@typescript-eslint/no-floating-promises': 'error',

      /**
       * QUALITY
       */
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  {
    files: ['src/**/*.ts'],

    rules: {
      '@typescript-eslint/no-explicit-any': 'error',

      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: false,
          allowTypedFunctionExpressions: false,
          allowHigherOrderFunctions: false,
        },
      ],

      'import/no-default-export': 'error',

      'no-restricted-syntax': ['error', ...LOG_EVENT_RULES],
    },
  },

  /**
   * 📏 METRIC LABEL GUARDRAIL (ADR 003 §8.2)
   * A later block REPLACES no-restricted-syntax instead of merging it, so the
   * log-event selectors are repeated here — otherwise these files lose them.
   */
  {
    files: METRIC_LABEL_FILES,

    rules: {
      'no-restricted-syntax': ['error', ...LOG_EVENT_RULES, METRIC_LABEL_RULE],
    },
  },

  /**
   * 🧱 TELEMETRY BOUNDARIES
   * The telemetry bootstrap is preloaded before the app. Anything it imports
   * loads before instrumentation and goes unpatched, and config/index.ts
   * drags in env.schema → registry → plugins → winston. The logger takes its
   * settings via configureLogger() instead of importing config.
   */
  {
    files: ['src/**/*.ts'],

    settings: {
      'import/resolver': { node: { extensions: ['.ts', '.js'] } },
    },

    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: ['./src/telemetry', './src/utils/logger.ts'],
              from: ['./src/config/index.ts', './src/config/env.schema.ts'],
              message: 'Must not import config/index.ts — see ADR 003 §5 Phase 0.',
            },
            {
              target: './src/telemetry',
              from: [
                './src/app.ts',
                './src/server.ts',
                './src/bootstrap.ts',
                './src/controllers',
                './src/routes',
                './src/middleware',
                './src/services',
                './src/store',
                './src/gateways',
                './src/utils/logger.ts',
              ],
              message:
                'Telemetry loads before the app — importing app code here leaves it unpatched (ADR 003 §5).',
            },
            {
              target: [
                './src/!(telemetry|config)/**/*',
                './src/*.ts',
                './src/config/index.ts',
                './src/config/env.schema.ts',
              ],
              from: './src/config/runtime.ts',
              message:
                'config/runtime.ts is for src/telemetry/ only — everything else reads config.',
            },
          ],
        },
      ],
    },
  },

  /**
   * 📜 SCRIPTS + ESM preloads — plain Node ESM
   */
  {
    files: ['scripts/**/*.mjs', 'src/**/*.mjs'],

    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },

  /**
   *  MOCKS — relaxed (infra/testing helpers)
   */
  {
    files: ['mocks/**/*.ts'],

    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  /**
   * TESTS — relaxed rules
   */
  {
    files: ['tests/**/*.ts'],

    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  /**
   * CONFIG FILES  allow default exports
   */
  {
    files: ['*.config.ts', 'vitest.*.ts'],

    rules: {
      'import/no-default-export': 'off',
    },
  },

  /**
   * Special case: app.ts can use default export
   */
  {
    files: ['src/app.ts'],

    rules: {
      'import/no-default-export': 'off',
    },
  },
];
