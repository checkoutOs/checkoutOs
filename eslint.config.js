import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default [
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

  /**
   * 🔴 STRICT RULES — ONLY for production code
   */
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
    },
  },

  /**
   * 🎭 MOCKS — relaxed (infra/testing helpers)
   */
  {
    files: ['mocks/**/*.ts'],

    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  /**
   * 🧪 TESTS — relaxed rules
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
   * ⚙️ CONFIG FILES — allow default exports
   */
  {
    files: ['*.config.ts', 'vitest.*.ts'],

    rules: {
      'import/no-default-export': 'off',
    },
  },

  /**
   * ✅ Special case: app.ts can use default export
   */
  {
    files: ['src/app.ts'],

    rules: {
      'import/no-default-export': 'off',
    },
  },
];
