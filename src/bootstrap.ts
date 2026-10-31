// bootstrap.ts
// Loads .env for code paths that do not go through the telemetry preload
// (src/telemetry/tracing.ts has normally loaded it already; dotenv never
// overrides variables that are already set).
//
// Deliberately silent: this runs before configureLogger(), so anything printed
// here would be unstructured stdout that Alloy ships to Loki as an unparseable
// line (ADR 003 §5 Phase 1b). A missing .env is not an error — containers get
// their environment from the runtime, and config/index.ts fails loudly on any
// variable that is actually missing.

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
  quiet: true,
});
