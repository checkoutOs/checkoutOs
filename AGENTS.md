# checkoutOs — Agent Guide

name: checkoutos
description: checkoutOs is a redirect-based, SDK-less HTTP API payment orchestration system that provides a unified interface for Indian payment gateways (Razorpay, Paytm, PayU, Cashfree). It handles idempotent payment creation, status polling, webhook processing, and refunds with Redis-backed state management.

# Purpose
You are an expert contributor for checkoutOs.

Before writing code, always consult the project documentation:
- `docs/adr/` — Architecture Decision Records (001 idempotency, 002 Paytm integration, 003 observability plan — *Proposed*; Phases 0–6 implemented: `src/telemetry/`, `/metrics` on :9464, structured event logs, `observability/` Prometheus/Loki/Tempo stack, exposition snapshot, label guardrails, domain metrics, dashboards + alerts, opt-in OTLP traces).
- `docs/metrics.md` — **the user-facing metric contract**: every metric, type, unit, labels, allowed values, buckets, and the stability policy. Update it with any metric change.
- `projectSpec/` — architecture spec (`v1oArchitectureDesign.md`), contributor guide (`contributorguide.md`), build steps (`Steps.md`), gateway guide (`GatewayIntegrationGuide.md` — currently a duplicate of `Steps.md`), plus PDF handbooks.
- `idempotency.md` (repo root) — full idempotency implementation plan.
- `openapi.yaml` — public API contract. Update it when you change request/response shapes.
- `helpers/docs/*.md` are **empty placeholders** — don't rely on them.

## Project

checkoutOs is an infrastructure-grade payment orchestration system.

The architecture is plugin-based.

Supported gateways (names in `supportedGateways`):
- Razorpay — implemented
- Paytm — implemented
- PayU — stub only
- Cashfree — stub only

Never break architectural contracts.

---
# Architecture Rules

Controllers

- HTTP only
- No business logic
- No Redis or DB
- No gateway-specific code

Services

- Own business logic
- Orchestrate store + gateway
- Never import gateway implementation directly
- Use gateway registry

Store

- Only layer allowed to access Redis or DB

Gateway

- Implement GatewayPlugin
- Implement GatewayMapper
- Never leak gateway-specific models

Utils

- Pure functions
- `utils/redact.ts` — `redactWebhookEvent(event)` returns `{ gateway, event, status, amount, currency }`: no `raw`, no gateway IDs. Use it for **anything** derived from a `WebhookEvent` that is logged, put on a span, or sent out. It is an allow-list (`WEBHOOK_EVENT_FIELDS` must decide every `WebhookEvent` key), so a new `WebhookEvent` field is a compile error until classified
- No side effects
- `utils/logger.ts` must **not** import config/store/services/errors, nor `config/runtime.ts` (see "Startup import cycle" below)

Telemetry (`src/telemetry/`, ADR 003)

- Peer layer of Store; emitting telemetry is a side effect, so it never lives in Utils
- `tracing.ts` is the preloaded bootstrap and the **only** file that names an exporter. Business code emits through the OTel API (`metrics.ts` instruments) and never names a destination
- Telemetry imports only `dotenv`, `config/runtime.ts`, `@opentelemetry/*`, node built-ins, sibling telemetry modules and `import type` from `src/types/` (erased at runtime) — never `config/index.ts`, the logger or app code (they would load before instrumentation and go unpatched). Enforced by `import/no-restricted-paths`
- `tracing.ts` loads `.env` itself, **then** calls `loadRuntime()`; other telemetry modules receive `runtime` as a parameter
- Exactly one `MeterProvider`, owned by `NodeSDK`. Never construct one in `src/`; never call `getMeter()` before `sdk.start()` (the API has no proxy — such a meter is a permanent no-op)
- Business instruments are all defined in `metrics.ts` and reached through `telemetry()` (lazy, memoised — call it at record time, never at module load). Names are dotted with **no unit suffix** (set `unit: 's'`; exporter 0.223 renders no `_seconds`), counters never end in `_total` (the exporter adds it). Time with `process.hrtime.bigint()` + `secondsSince()`
- Webhook processing time is recorded **before** the relay call; relay time has its own histogram. Never nest them
- **Traces**: spans are always created (that is what puts `trace_id` on log lines) but exported **only** when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or the generic `OTEL_EXPORTER_OTLP_ENDPOINT`, which also enables OTLP metrics push) is set — `runtime.otlpTracesEnabled`. Otherwise the no-op processor in `tracing.ts` stays (never "fix" it with `OTEL_TRACES_EXPORTER=none`). With an endpoint: `ErrorBiasedSpanProcessor` (`sampling.ts`) → `BatchSpanProcessor` → OTLP/HTTP
  - Sampling is a **trace-level tail decision in-process**, not a head `Sampler` (a sampler cannot know a request will fail): spans are buffered per trace and decided when the local root ends — kept if the trace **failed** (root span ERROR or HTTP ≥ 500, or any CLIENT/PRODUCER/CONSUMER span ERROR — a gateway call, Redis, the relay), else kept if `traceIdRatio(traceId) < TRACE_SAMPLE_RATIO` (default 0.1). ERROR on **INTERNAL** spans is ignored: the Express instrumentation sets it on every `next(err)`, including expected 4xx
  - Buffer is bounded (2 000 undecided traces, 512 spans/trace, 60 s TTL). The head sampled flag is unchanged, so downstream services still see sampled=1
  - A gateway answering 4xx to `healthCheck()` (wrong credentials; the MSW mock has no list-orders route) makes **every** `/health` trace a failure — expected, and a real signal
- Under `NODE_ENV=test` nothing is constructed — instrumentation constructors patch modules immediately and would race the vitest `ioredis` mock
- Metric labels come **only** from `src/telemetry/attributes.ts` builders (ADR 003 §8.2): `gatewayLabels(gateway, operation, outcome)`, `webhookLabels(gateway)`, `httpLabels(method, route, status)`, `buildInfoLabels(version)`. Each value is closed twice — a union type at compile time, and at run time anything outside the set collapses to `unknown` / `_OTHER` / `unmatched` instead of becoming a new series. Builders never throw. Never `chkId`, `orderId`, gateway IDs, raw paths or customer data as labels
- `METRIC_GATEWAYS` mirrors `supportedGateways` and `HTTP_ROUTES` mirrors the routers mounted in `app.ts` (not imported — telemetry must not load the registry). `tests/unit/telemetry/attributes.test.ts` fails on drift: **adding a gateway or a route means adding it there too**

Middleware

- Request preparation only (e.g. idempotency header validation + request hash)
- No Redis, no service calls; errors go through `next(err)`

---

# Engineering Rules

- Typescript strict
- exactOptionalPropertyTypes enabled
- Never use any
- Prefix explicit typing
- All errors extend AppError
- Fail fast
- Never silently ignore unknown gateway states
- Unknown status -> GatewayMappingError
- Only `src/config/env.schema.ts` and `src/config/index.ts` may read `process.env` (exceptions today: `app.ts` passes `process.env` into `registerGateways`, and `src/config/runtime.ts` — the telemetry bootstrap's early read, which has **no imports** and is imported **only** by `src/telemetry/`; enforced by `tests/unit/config/runtime.test.ts`)
- No module cycles — check with `npm run lint:circular`

---

# Gateway Rules

Every new gateway must include

- types
- mapper
- plugin
- tests
- registration
- webhook verification
- mock handlers (`mocks/gateways/<gateway>/handlers.ts`)
- `withTelemetry(...)` around the plugin at its `gatewayPlugins[...] =` line in `gateway.registry.ts`
- its webhook signature-failure **error code** in `SIGNATURE_FAILURE_CODES` (`src/telemetry/gateway.decorator.ts`) if it throws one other than `GATEWAY_INVALID_SIGNATURE` — classification is by code, never by class, and this is the one thing the decorator cannot infer
- its name in `METRIC_GATEWAYS` and its webhook event names in `WEBHOOK_EVENTS` (`src/telemetry/attributes.ts`) — `attributes.test.ts` fails until they match

Never modify service architecture to support one gateway.

Gateway-specific behavior stays inside the plugin.

Never add metrics or other instrumentation inside a plugin file. Gateway metrics (`gateway.request.duration`, `gateway.requests`, `webhook.signature_failures`) come from the `withTelemetry()` decorator applied in `gateway.registry.ts` (ADR 003 §6.1), so every gateway is instrumented the day it is registered. The decorator `.bind(plugin)`s every method (plugins are classes using `this`), keeps `parseWebhookEvent` **synchronous**, passes `getCheckoutAction` through, and classifies outcomes by error code (`GATEWAY_TIMEOUT` → `timeout`, `GATEWAY_MAPPING_ERROR` → `mapping_error`, anything else → `gateway_error`). `getActiveGateway()` returns the wrapper, not the plugin instance — never `instanceof` it.

---

# When implementing features

Before coding:

1. Determine affected layers.
2. Follow project contracts.
3. Preserve backward compatibility.
4. Add tests.
5. Update documentation (incl. `openapi.yaml` and an ADR for significant decisions).

---

## Quick start (local dev)
```bash
cp .env.example .env
docker run -d --name checkoutos-redis -p 6379:6379 redis:7-alpine
npm run mock:gateway    # MSW mock Razorpay + Paytm on :9090
npm run dev             # tsx watch on :3000, /metrics on :9464
```
Metrics/logs in Grafana: `docker compose --profile metrics up -d --build` (or `--profile observability` for logs too) → `http://localhost:3001` (see Docker).
To hit the mock instead of real gateways, set `RAZORPAY_BASE_URL=http://localhost:9090` (or `PAYTM_BASE_URL=http://localhost:9090`) in `.env`.

## Commands
| Command | What it does |
|---------|-------------|
| `npm run dev` | Dev server with hot-reload via `tsx watch`, telemetry preloaded via `--import ./src/telemetry/register.mjs` (ESM loader hook) |
| `npm run build` | `tsc` → `dist/`, then writes `dist/package.json` `{"type":"commonjs"}` (without it Node parses the CJS output as ESM and `npm start` dies with `exports is not defined`) |
| `npm start` | Run compiled `dist/server.js` with `--require ./dist/telemetry/tracing.js` |
| `npm run verify:telemetry` | Builds, boots **both** `npm start` and `npm run dev` on :3100/:9564 against a local stub gateway (:9590 — no gateway creds/internet needed), drives a short business flow (create payment, idempotent replay, orderId dedup, forged + signed + replayed + unknown webhooks, refund — relay always to a refused local port), asserts `/metrics` auth, `http_route="/health"`, `checkoutos_build_info`, one HTTP histogram with the semconv label keys, every business metric family the flow should produce, no OTLP egress to :4318, and identical metric shapes for both entry points; then (re)writes `observability/exposition.snapshot.txt`. Add `-- --check` to fail instead of writing (CI does). Redis required |
| `npm run typecheck` | `tsc --noEmit` — strict mode |
| `npm run lint:circular` | `madge --circular` over `src/` — detects import cycles |
| `npm run mock:gateway` | MSW mock gateway server on :9090 (Razorpay + Paytm) |
| `npm run test:unit` | Vitest `unit` project — no Redis needed |
| `npm run test:integration` | Vitest `integration` project — Redis required |
| `npm run test:coverage` | Coverage (lines 70%, funcs 70%, branches 60%) |
| `npm run test:watch` | Watch mode (unit only) |

**`npm test` is a dead placeholder (exit 1). Never use it.**
There is no `lint` script — run `npx eslint .` directly.

## Testing
- **Unit tests** (`tests/unit/`): `ioredis` → `ioredis-mock` via `vi.mock()` in `vitest.setup.unit.ts`; no external services.
- **The logger is NOT mocked.** Both setup files call `configureLogger({ isTest: true, isDevelopment: false })` (the test composition root) → `logger.silent`. Never re-add a `vi.mock` of the logger. To assert on output, reconfigure and capture through a stream transport (see `tests/unit/utils/logger.test.ts`).
- **Integration tests** (`tests/integration/`): Real Redis at `localhost:6379` required. `axios` is **not** mocked (the setup file's header comment saying otherwise is stale).
- ⚠️ **Integration gateway target**: `vitest.config.ts` sets `RAZORPAY_BASE_URL=http://localhost:9090`, but `vitest.setup.integration.ts` **overrides** it at module load with `https://api.razorpay.com/v1` and hardcoded Razorpay *test-mode* credentials. Integration tests therefore hit the **real Razorpay sandbox**, not the mock server.
- Integration test files run **serially** (`fileParallelism: false`); unit tests timeout 5 s, integration 15 s.
- `beforeEach` in integration setup deletes all `chk:*` keys from Redis — prevents cross-test contamination (also clears `chk:idem:*`, `chk:ref:*`).
- `tests/helpers/app.helper.ts`: `createTestApp()` (singleton `buildApp()`) + `registerTestGateway()` (registers Razorpay, swallows errors) — does **not** call `initialise()`.
- Env vars must be set at **top level** of setup files — `config/index.ts` parses env at import time.
- Run order: `npm run test:unit && npm run test:integration && npm run verify:telemetry` — the same chain runs in CI (`.github/workflows/ci.yml`, after typecheck, eslint, `lint:circular` and `log-events.mjs check`). CI is red until the 9 known integration failures (Known issues) are fixed.
- **Exposition snapshot** (`observability/exposition.snapshot.txt`, ADR 003 §7.3): the *shape* of `/metrics` — metric names, HELP/UNIT/TYPE, label **keys**, histogram `le` boundaries; never values. Generated, never hand-edited. Any metric rename, new label or bucket change shows up as a diff here: review it as a public-contract change and commit it with the code, or CI fails. `target_info` keeps only `service_*`/`deployment_*` keys (host/process detector keys vary by OS).
- The OTel SDK never starts under vitest (`NODE_ENV=test`) — never import `src/telemetry/tracing` or `server.ts` from a test. Telemetry wiring is tested end to end by `verify:telemetry`, not by vitest.
- To assert on metrics in a unit test, call `installTestMeterProvider()` from `tests/helpers/metrics.helper.ts` at the **top** of the file (before anything records — `telemetry()` memoises) and assert with `delta(name, labels, fn)` (values are cumulative). Examples: `tests/unit/telemetry/gateway.decorator.test.ts`, `tests/unit/services/webhook.service.metrics.test.ts`.

## Architecture
- **Express 5** app, `"type": "module"` in package.json (ESM sources, CommonJS output via `tsc`; `tsx` bridges the gap at dev time).
- Entry: preload `src/telemetry/tracing` (dotenv → OTel SDK → `/metrics` listener) → `src/server.ts` (imports `./telemetry` **first**, same instance) → `src/bootstrap.ts` (dotenv) → `configureLogger(config)` → `verifyTelemetry()` (scrapes own `/metrics`, refuses to boot without `checkoutos_build_info`) → `src/app.ts` (`initialise()` then `buildApp()`) → `listen`. SIGTERM/SIGINT trigger graceful shutdown (close server → disconnect Redis → `shutdownTelemetry()`, 10 s force-exit).
- `initialise()` calls `registerGateways()` then `connectRedis()` — failure exits the process.
- `buildApp()` is a pure factory with no side effects; safe to call in tests.
- Layer: routes → (middleware) → controllers → services → `getActiveGateway()` (GatewayPlugin) + stores (Redis).
- `@` path alias is declared in `vitest.config.ts` but does **not** resolve inside the `unit`/`integration` projects — tests use relative `../../../src/...` imports. `src/` itself uses relative imports — keep it that way (tsc has no `paths` configured).
- Body parsing order in `src/app.ts`: request logger → `express.raw()` for `/webhooks/razorpay` → `express.urlencoded()` for `/webhooks/paytm` → mount webhook router → `express.json()` for all other routes → routes → `notFoundHandler` → `errorHandler` (last). **Order is load-sensitive.**
- `src/middleware/request-logger.ts` — `requestLogger`, mounted first in `buildApp()`; logs `http.request.completed` (component `request-logger`). **Logs only, no metrics**: HTTP duration is `http.server.request.duration` from `HttpInstrumentation` (labels `http_route`, `http_request_method`, `http_response_status_code`). Never define a second HTTP duration histogram — a duplicate family makes Prometheus reject the whole scrape; `verify:telemetry` fails on it.
- Payment IDs: `chk_` prefix. Refund IDs: `ref_` prefix. Amounts in **paise** (₹500 = 50000). Only `INR` supported.
- `GET /checkout/:chkId` serves **HTML**, not JSON. The controller asks the plugin's `getCheckoutAction()`: Razorpay returns `{ type: 'render' }` (JS SDK page), Paytm returns `{ type: 'redirect', url }`.

### HTTP routes
| Method | Path | Notes |
|---|---|---|
| POST | `/payments` | Requires `Idempotency-Key` header (UUID); `orderId` required |
| GET | `/payments/:chkId` | Status with staleness re-poll |
| POST | `/payments/:chkId/refund` | Full or partial refund (no idempotency yet — deferred to V1.2) |
| GET | `/refunds/:refId` | Refund status |
| POST | `/webhooks/:gateway` | Gateway webhooks (`razorpay`, `paytm`) |
| GET | `/health` | Redis ping + active gateway `healthCheck()` |
| GET | `/checkout/:chkId` | HTML checkout page |

### Redis key patterns
| Key | Type | Purpose |
|---|---|---|
| `chk:pay:{chk_id}` | Hash | `StoredPayment` |
| `chk:gw:{gateway}:{gw_id}` | String | reverse lookup gateway id → `chk_id` |
| `chk:pay:by-order:{orderId}` | String | merchant `orderId` → `chk_id` (reserved via SET NX, 30 s reservation TTL) |
| `chk:ref:{ref_id}` | Hash | `StoredRefund` |
| `chk:ref:by-pay:{chk_id}` | Set | all `ref_id`s for a payment |
| `chk:idem:{key}` | String (JSON) | `IdempotencyRecord`, TTL 24 h |

## Idempotency (POST /payments) — see `docs/adr/001-idempotency.md`
- `idempotencyMiddleware` validates the `Idempotency-Key` header (missing → 400 `MISSING_IDEMPOTENCY_KEY`, non-UUID → 400 `INVALID_IDEMPOTENCY_KEY`) and attaches `req.idempotency = { key, requestHash }`.
- `requestHash` = SHA-256 of method + `req.baseUrl + req.path` (trailing slash trimmed; **not** `originalUrl`, so query strings are excluded) + canonicalised body (`utils/hash.ts`).
- `idempotency.service.ts`: `checkIdempotency` → `MISS` / `HIT` (cached response) / `IN_PROGRESS` (409); same key + different hash → 400 `IDEMPOTENCY_KEY_REUSED`.
- Stale `IN_PROGRESS` records (> 30 s) are recovered atomically via Lua; race retries capped at 3.
- `releaseIdempotency` deletes the claim **only** when the gateway was provably never called; `completeIdempotency` never throws.
- Second dedup dimension: merchant `orderId` (max 64 chars, `[A-Za-z0-9_.-]`). Same orderId + same amount/currency → existing payment returned; different amount/currency → 409; concurrent create → 409 `OrderCreationInProgressError`.

## Gateways
- **Razorpay**: implemented (`src/gateways/razorpay/`), registered. Webhooks are HMAC-SHA256 over the raw JSON body.
- **Paytm**: implemented (`src/gateways/paytm/`, uses `paytmchecksum`), **registered** in `gateway.registry.ts`. Webhooks are URL-encoded with `CHECKSUMHASH`. `websiteName` comes from `PAYTM_WEBSITE_NAME` (defaults to `WEBSTAGING` sandbox — set `DEFAULT` or your assigned name in production). `getRefundStatus()` always throws `GatewayUnavailableError` (refund status arrives only via webhook). Paytm-specific errors live in `src/errors/paytm.errors.ts`.
- **PayU, Cashfree**: plugin + mapper files are **empty**; `registerGateways` throws for both at startup.
- `src/gateways/gateway.registry.ts` — single source of truth for supported gateway names, required env keys, credential key maps, and base URLs (+ `*_BASE_URL` override). It must never import `config/index.ts` or read `process.env`. Adding a gateway = registry entry + `switch` case (wrapped in `withTelemetry`) + plugin + its telemetry closed sets; no service/controller changes.
- `GatewayPlugin` interface lives in `src/types/gateway.types.ts` (`createPayment`, `getPaymentStatus`, `createRefund`, `getRefundStatus`, `parseWebhookEvent`, `getCheckoutAction`, `healthCheck`). `gateway.interface.ts` and `src/gateways/index.ts` are empty.
- Services never import gateway folders directly — always call `getActiveGateway()`.
- `ACTIVE_GATEWAY` env var selects the active gateway; Zod `superRefine` makes its `requiredEnvKeys` mandatory at startup (Paytm requires only merchant ID + key; webhook secret optional).

## Payment flow invariants
- `gatewayOrderId` set at payment creation; `gatewayPaymentId` (e.g. `pay_XXXX`) starts as `''` and is backfilled **only when a webhook arrives**.
- Polling (`getPaymentStatus`) never transitions to SUCCESS — that path is webhook-only. Terminal statuses are served from Redis; fresh records are served from Redis; stale ones re-poll the gateway.
- Refunds require status SUCCESS or PARTIALLY_REFUNDED **and** a non-empty `gatewayPaymentId` (webhook must precede any refund).
- Partial refunds stack: a PARTIALLY_REFUNDED payment can receive further refunds; refunding the full amount sets REFUNDED.
- Valid webhook status transitions (`VALID_TRANSITIONS` in `webhook.service.ts`; invalid transitions are ignored with a warning, not errors):
  - `PENDING` → PROCESSING, SUCCESS, FAILED, CANCELLED, EXPIRED
  - `PROCESSING` → SUCCESS, FAILED, CANCELLED, EXPIRED
  - SUCCESS / FAILED / CANCELLED / EXPIRED / REFUNDED / PARTIALLY_REFUNDED → (terminal, no transitions)
- Redis state is always updated **before** the relay is attempted.
- Webhook relay to `WEBHOOK_RELAY_URL` is fire-and-forget (5 s timeout); relay failure logs a warning and does not fail the request.
- Relay payload is `{ paymentId: chkId, ...event }` — the spread **also forwards `raw` (the full gateway payload), `gatewayPaymentId` and `gatewayOrderId`** to `WEBHOOK_RELAY_URL`. Pre-existing; changing it changes the merchant-facing payload (needs a decision + `openapi.yaml`). `redactWebhookEvent()` is the helper that would fix it.

## Errors
- Base: abstract `AppError` (`src/errors/app.errors.ts`) with `httpStatus`, `code` (from `ErrorCode` in `types/common.types.ts`), `details`, `isOperational`.
- Files: `payment.errors.ts`, `gateways.errors.ts`, `idempotency.errors.ts`, `paytm.errors.ts`, `store.errors.ts`; re-exported from `src/errors/index.ts`.
- `errorHandler` maps `AppError` → its status; anything else → 500 `INTERNAL_ERROR` with no internals leaked. Store layer wraps every ioredis error in `StoreError`.
- Controllers wrap handlers in `asyncHandler` so rejections reach `next(err)`.

## TypeScript quirks
- Targets ES2021, emits CommonJS (`tsc`); `tsx` handles ESM→CJS at dev time.
- Strict flags that trip agents: `noUncheckedIndexedAccess` (indexed access returns `T | undefined`), `exactOptionalPropertyTypes` (can't assign `undefined` to optional props — use conditional spreads like `...(x && { prop: x })`), `noImplicitReturns` (all code paths must return).
- `rootDir: "src"` — only `src/` is compiled by `tsc`; tests/mocks are excluded from build.
- ESLint uses `tsconfig.eslint.json` (not `tsconfig.json`) to widen `rootDir` to `.` for type-checking tests and mocks.
- `Request.idempotency` is added by module augmentation in `src/types/express.types.ts` — import it for side effects where used.

### Startup import cycle (fixed — don't reintroduce)
`config/index.ts → env.schema.ts → gateway.registry.ts → paytm.plugin.ts → utils/logger.ts` used to loop back to `config`, causing a TDZ `ReferenceError` at startup. The logger now takes settings via `configureLogger()` from `server.ts` and defaults to production JSON at `info` level until then. Never import `config` from the logger or from anything the registry imports.

`LoggerSettings` also carries optional `service`, `env`, `version`, `format` and `isTTY`. Every record gets `service` (default `checkoutos`) plus `env`/`version` via `defaultMeta`. Format: `format` (from `LOG_FORMAT`) wins; otherwise pretty only when `isTTY` (passed by `server.ts` from `process.stdout.isTTY`), JSON everywhere else — including `NODE_ENV=development` off a terminal. Silencing is `logger.silent` (there is no `'silent'` level). Each call re-applies everything, so an omitted field resets to its default. Extend these settings when the logger needs a new value — don't import `config`, `config/runtime.ts` or `src/errors`, and make no ambient reads (`process.env`, `process.stdout`).

### Logging conventions (ADR 003 §5 Phase 1a)
- Call shape: `log.<level>('<event>', fields?)`, with `const log = createContextLogger('<component>')`. Records are `{ ...fields, event, component }`; `message` equals `event` (no `[context]` prefix).
- Event names are **static**, dotted, lowercase, underscores within segments: `payment.created`, `webhook.relay_failed`, `http.error.operational`. Namespaces: `payment.` `refund.` `webhook.` `gateway.` `idempotency.` `orderid.` `redis.` `server.` `health.` `http.`. Dynamic values go in fields (`server.shutdown_started`, `{ signal }`). Enforced by `no-restricted-syntax` (`LOG_EVENT_PATTERN` in `eslint.config.js`, pinned by `tests/unit/lint/log-events.test.ts`).
- Reserved field keys — `message`, `event`, `component`, `level` — are a **compile error** (`LogFields`). winston concatenates a meta `message` onto the record message. Use `errorMessage`, `gatewayEvent`, etc.
- `Error`s in fields are expanded (name, message, stack, and AppError `code`/`details`) — pass the Error itself, not `err.message`, when the stack matters.
- `http.request.completed` (app.ts) logs `path` (from `originalUrl`, no query string) and `route` (the bounded pattern, e.g. `/payments/:chkId`, captured when Express assigns `req.route` — it is wrong if read at `finish`).
- Never put `chkId`, `orderId`, gateway IDs or customer data in a Loki **label**; they belong in the log body.
- `scripts/event-map.json` records every pre-migration name → new name (use it to migrate saved Loki queries). `node scripts/log-events.mjs check` lists any non-conforming call site.

## Linting & formatting
- All `**/*.ts`: `no-floating-promises: error`, `no-unused-vars` (args prefixed `_` ignored). Uses `typescript-eslint` recommended + strict.
- `src/**/*.ts`: `no-explicit-any: error`, `explicit-function-return-type: error` (no exceptions — `allowExpressions: false`), `import/no-default-export: error`.
- `src/app.ts` is the **only** production file allowed a default export (config files and `vitest.*.ts` are also exempt).
- `tests/`: `explicit-function-return-type`, `no-non-null-assertion`, `ban-ts-comment`, `no-unused-vars` all off.
- `mocks/`: `no-explicit-any` and `explicit-function-return-type` off.
- Prettier: single quotes, semicolons, trailing commas, 100 print width.
- `dist/` and `coverage/` are ignored. `scripts/**/*.mjs` and `src/**/*.mjs` get Node globals.
- `import/no-restricted-paths` guards the telemetry boundaries (see Architecture Rules → Telemetry).
- `no-restricted-syntax` on `src/**/*.ts`: the first argument of any `log.*(...)` / `log[level](...)` call must be a string literal matching `LOG_EVENT_PATTERN` (see Logging conventions).
- `no-restricted-syntax` on `METRIC_LABEL_FILES` (services, middleware, telemetry): no object literal as an argument to `.add` / `.record` / `.observe` — use an `attributes.ts` builder. Pinned by `tests/unit/lint/metric-labels.test.ts`.
  - ⚠️ A later flat-config block **replaces** `no-restricted-syntax` for its files instead of merging. Any block that sets it must spread `LOG_EVENT_RULES` too (the fixture test fails otherwise).
- Pre-commit: husky runs `npx lint-staged` (`eslint --fix && prettier --write` on staged `*.{ts,js}`). Hooks install via the `prepare` script.

## Env config
- `src/config/env.schema.ts` Zod schema validates env at **module load time**; invalid config → `process.exit(1)` with a formatted error list.
- Required always: `ACTIVE_GATEWAY`, `REDIS_URL` (`redis://` or `rediss://`), `WEBHOOK_RELAY_URL` (http/https). `NODE_ENV` defaults to `development`, `PORT` to 3000 (must be 1024–65535).
- Optional overrides: `RAZORPAY_BASE_URL`, `PAYTM_BASE_URL`, `PAYTM_WEBSITE_NAME`. `PAYU_BASE_URL` / `CASHFREE_BASE_URL` are read by the registry but are not in the Zod schema.
- `BASE_URL` is **not** Zod-validated — read directly via `process.env.BASE_URL` in `config/index.ts` (defaults to `http://localhost:3000`). Set it explicitly in production.
- Observability (all optional, ADR 003): `APP_VERSION` (default `0.0.0`), `LOG_FORMAT` (`json`|`pretty`), `METRICS_PORT` (default 9464, 1024–65535, must differ from `PORT`), `METRICS_AUTH_TOKEN` (non-empty when set), `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (enables trace export), `TRACE_SAMPLE_RATIO` (0–1, default 0.1 — share of non-failed traces kept). `src/config/runtime.ts` `loadRuntime()` reads the same variables early, without validation, for `src/telemetry/`. Invalid values still fail startup in Zod.
- `config` object groups: `config.env/port/isDevelopment/isProduction/isTest`, `config.gateway.active`, `config.gateway.credentials`, `config.redis.url`, `config.webhook.relayUrl`, `config.app.baseUrl`, `config.app.version`, `config.log.format`, `config.metrics.port/authToken`.

## Mock server (`npm run mock:gateway`)
- MSW-based HTTP server (`@mswjs/http-middleware`) on port 9090 (override via `MOCK_PORT`).
- Razorpay: `POST /v1/orders`, `GET /v1/orders/:id`, `POST` refund, `GET /v1/refunds/:id`. Auth is validated (401 on wrong/missing Basic Auth).
- Paytm: `POST /theia/api/v1/initiateTransaction`, `/transactionStatus`, `/refundTransaction`.
- Mostly deterministic (order IDs derived from receipt, `created_at` fixed), except Razorpay refund IDs use `Date.now()`.
- Test creds: `RAZORPAY_KEY_ID=rzp_test_mockKeyId00001`, `RAZORPAY_KEY_SECRET=mockSecret00001`, `PAYTM_MERCHANT_KEY=paytm_test_key_001` (merchant ID printed on startup / exported as `MOCK_PAYTM_MERCHANT_ID`).
- Add a gateway: create `mocks/gateways/<gateway>/handlers.ts`, spread into `allHandlers` in `mocks/server.ts`.

## Docker
- Root `Dockerfile`: multi-stage (`node:20-alpine`), non-root `checkoutos` user (uid/gid 1001), healthcheck on `/health`. Both stages run `npm pkg delete scripts.prepare` before `npm ci` so husky (a devDependency) doesn't break the build.
- `CMD` preloads telemetry (`node --require ./dist/telemetry/tracing.js dist/server.js`). `APP_VERSION` is a build arg (`--build-arg APP_VERSION=...`), default `0.0.0`.
- Port 9464 (`/metrics`) is `EXPOSE`d for documentation only and is **not** published by compose — scrape it on the compose network as `checkoutos:9464`.
- `docker compose up` starts app + Redis. Compose overrides `REDIS_URL` to `redis://redis:6379`.
- `docker compose --profile mock up` adds the MSW mock gateway on :9090 (`Dockerfile.mock`: `tsx mocks/server.ts`; mocks import nothing from `src/`).
- `.dockerignore` keeps `node_modules`, `.env` (credentials), `.git`, `dist`, tests and docs out of every build context — keep it in step if a Dockerfile starts COPYing something new.
- Every profile (none, `metrics`, `observability`, `mock`) was verified to start from a clean copy of the repo + `cp .env.example .env` (ADR 003 §10.1).
- Tiered profiles (`observability/`, pulled in by `include:` in the root compose file; each a superset): `docker compose --profile metrics up -d --build` adds Prometheus + Grafana; `--profile observability` adds Loki + Alloy as well. Grafana: `http://localhost:3001` (127.0.0.1 only, anonymous admin — local use only; Prometheus is the default datasource). Prometheus, Loki and Alloy are not published.
  - **Dashboards** (`observability/grafana/dashboards/*.json`: overview, gateways, webhooks, idempotency) are **generated** by `scripts/build-dashboards.mjs` — edit the generator, then run it; never hand-edit the JSON (CI runs `--check`). Provisioned read-only into a `checkoutOs` folder; Overview is the Grafana home.
  - **Alerts**: `observability/prometheus/alerts.yml` (the 7 from ADR 003 §10.2), loaded by Prometheus; no Alertmanager is wired. Every rule needs a firing case in `alerts.test.yml` (`promtool test rules`, in CI), and every latency threshold must be a bucket boundary in `src/telemetry/buckets.ts` — `tests/unit/observability/alerts.test.ts` enforces that, plus that every `checkoutos_*` metric used in alerts/dashboards is documented in `docs/metrics.md`.
  - **Examples** for other consumers (Prometheus, Alloy, Datadog, OTel Collector): `observability/examples/`.
  - **Tracing** (`--profile tracing`, superset of `observability`): adds Tempo 2.8 (`observability/tempo/tempo.yml`, OTLP on `tempo:4318`/`4317` inside the compose networks, 7-day retention). The profile does **not** turn export on — run `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://tempo:4318/v1/traces docker compose --profile tracing up -d --build` (root compose passes it through; empty by default). Grafana links both ways: Loki line → `trace_id` derived field → Tempo; Tempo span → its Loki lines. Tempo's image has no shell — healthchecks must use exec form; its ring is pinned to `127.0.0.1` because it sits on two networks
  - Verified end to end: 500 ordinary 404s → 49 traces kept (~10%); 20 failed payments (502) → 20 kept, each linked to its 5 log lines
  - Prometheus joins `checkoutos-network` (declared identically in both compose files — compose merges them) and scrapes `checkoutos:9464` every 15 s, 7-day retention. No scrape auth by default; if `METRICS_AUTH_TOKEN` is set, enable the commented `authorization` block in `observability/prometheus/prometheus.yml`. Query one request with `{service="checkoutos"} | trace_id="<id>"`.
  - Pipeline: app stdout JSON → Docker `json-file` (rotated: `max-size 10m`, `max-file 5`) → Alloy (`loki.source.docker`, Docker socket, filters on `com.docker.compose.service=checkoutos`) → Loki 3 (tsdb/v13, 7-day retention).
  - Loki **labels** (bounded): `service`, `env`, `level`, `component`, `compose_service`. **Structured metadata**: `trace_id`, `span_id`, `event`. Never promote IDs to labels.
  - `trace_id` is present on every line logged inside a request; startup/shutdown lines have none (no active span).
  - Any non-JSON stdout lands as an unparsed line — the only intentional ones are `config/index.ts`'s config-error banner and `server.ts`'s `Fatal startup error`. Never add `console.*` elsewhere in `src/`.
- `docker/Dockerfile` and `docker/docker-compose.yml` are empty stubs.

## Known issues / gotchas
- `src/controllers/checkout.controller.ts` imports `getActiveGateway()` directly — a violation of the "controllers have no gateway access" rule. Prefer moving it into `checkout.service.ts` when touching that code.
- `src/services/health.service.ts` imports `pingRedis` straight from `store/redis.client.ts`, although that file says services must not import it directly.
- `vitest.setup.integration.ts` commits Razorpay test-mode credentials and points integration tests at the real sandbox (see Testing).
- `README.md` still lists only Razorpay/PayU/Cashfree and is behind the code (no Paytm, no idempotency).
- `gateway.interface.ts`, `src/gateways/index.ts`, PayU/Cashfree files, and `helpers/docs/*.md` are empty.
- Refund creation has no idempotency yet (planned for V1.2).
- 9 integration tests fail on the current tree, independent of telemetry (reproduced on `ffdc74c`): 8 in `idempotency.test.ts` (Razorpay sandbox order creation returns 502) and `paytm.webhook.api.test.ts` "returns 401 when CHECKSUMHASH is invalid" (gets 200).
