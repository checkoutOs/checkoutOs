// eslint.config.d.ts
// Types for the values tests import from eslint.config.js
// (tests/unit/lint/*.test.ts). Keep in step with the exports there.

import type { Linter } from 'eslint';

export declare const LOG_EVENT_PATTERN: RegExp;
export declare const METRIC_LABEL_FILES: string[];

declare const config: Linter.Config[];
export default config;
