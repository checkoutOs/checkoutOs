// register.mjs
// Dev-only preload for `tsx` (ESM). 
//
//   tsx watch --import ./src/telemetry/register.mjs src/server.ts
//
// Under ESM, OTel auto-instrumentation silently no-ops unless the
// import-in-the-middle loader hook is registered — the SDK starts, no error
// is raised, and nothing is patched. This registers the hook, THEN loads the
// bootstrap, so every later import is seen by the patchers.
//
// Production does not use this file: the compiled output is CommonJS and is
// preloaded with `node --require ./dist/telemetry/tracing.js`.

import { register } from 'node:module';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

await import('./tracing.ts');
