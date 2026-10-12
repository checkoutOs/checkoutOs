# checkoutOs — Agent Guide

name: checkoutos
description: checkoutOs is a redirect-based, SDK-less HTTP API payment orchestration system that provides a unified interface for Indian payment gateways (Razorpay, Paytm, PayU, Cashfree). It handles idempotent payment creation, status polling, webhook processing, and refunds with Redis-backed state management.

# Purpose
You are an expert contributor for checkoutOs.

Before writing code, always consult the project documentation:
- `docs/adr/` — Architecture Decision Records (001 idempotency, 002 Paytm integration, 003 observability plan — *Proposed*; Phase 0 implemented: `src/telemetry/`, `/metrics` on :9464; logs/metrics phases pending).
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
- No side effects
- `utils/logger.ts` must **not** import config/store/services/errors, nor `config/runtime.ts` (see "Startup import cycle" below)

Telemetry (`src/telemetry/`, ADR 003)

- Peer layer of Store; emitting telemetry is a side effect, so it never lives in Utils
- `tracing.ts` is the preloaded bootstrap and the **only** file that names an exporter. Business code emits through the OTel API (`metrics.ts` instruments) and never names a destination
- Telemetry imports only `dotenv`, `config/runtime.ts`, `@opentelemetry/*`, node built-ins and sibling telemetry modules — never `config/index.ts`, the logger or app code (they would load before instrumentation and go unpatched). Enforced by `import/no-restricted-paths`
- `tracing.ts` loads `.env` itself, **then** calls `loadRuntime()`; other telemetry modules receive `runtime` as a parameter
- Exactly one `MeterProvider`, owned by `NodeSDK`. Never construct one; never call `getMeter()` before `sdk.start()` (the API has no proxy — such a meter is a permanent no-op)
- Under `NODE_ENV=test` nothing is constructed — instrumentation constructors patch modules immediately and would race the vitest `ioredis` mock
- Metric labels will come only from `src/telemetry/attributes.ts` builders (ADR 003 §8.2, lands in Phase 4) — never `chkId`, `orderId`, gateway IDs or customer data as labels

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
- Only `src/config/env.schema.ts` and `src/config/index.ts` may read `process.env` (exceptions today: `server.ts` debug log, `app.ts` passes `process.env` into `registerGateways`, and `src/config/runtime.ts` — the telemetry bootstrap's early read, which has **no imports** and is imported **only** by `src/telemetry/`; enforced by `tests/unit/config/runtime.test.ts`)
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

Never modify service architecture to support one gateway.

Gateway-specific behavior stays inside the plugin.

Never add metrics or other instrumentation inside a plugin file. Gateway metrics come from the `withTelemetry()` decorator applied in `gateway.registry.ts` (ADR 003 §6.1, lands in Phase 3), so every gateway is instrumented the day it is registered.

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
To hit the mock instead of real gateways, set `RAZORPAY_BASE_URL=http://localhost:9090` (or `PAYTM_BASE_URL=http://localhost:9090`) in `.env`.

## Commands
| Command | What it does |
|---------|-------------|
| `npm run dev` | Dev server with hot-reload via `tsx watch`, telemetry preloaded via `--import ./src/telemetry/register.mjs` (ESM loader hook) |
| `npm run build` | `tsc` → `dist/`, then writes `dist/package.json` `{"type":"commonjs"}` (without it Node parses the CJS output as ESM and `npm start` dies with `exports is not defined`) |
| `npm start` | Run compiled `dist/server.js` with `--require ./dist/telemetry/tracing.js` |
| `npm run verify:telemetry` | Builds, boots **both** `npm start` and `npm run dev` on :3100/:9564, asserts `/metrics` auth, `http_route="/health"`, `checkoutos_build_info` and no OTLP egress to :4318 — Redis required |
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
- **Unit tests** (`tests/unit/`): `ioredis` → `ioredis-mock` via `vi.mock()` in `vitest.setup.unit.ts`; logger silenced (the mock must expose `logger`, `configureLogger`, `createContextLogger`); no external services.
- **Integration tests** (`tests/integration/`): Real Redis at `localhost:6379` required. `axios` is **not** mocked (the setup file's header comment saying otherwise is stale).
- ⚠️ **Integration gateway target**: `vitest.config.ts` sets `RAZORPAY_BASE_URL=http://localhost:9090`, but `vitest.setup.integration.ts` **overrides** it at module load with `https://api.razorpay.com/v1` and hardcoded Razorpay *test-mode* credentials. Integration tests therefore hit the **real Razorpay sandbox**, not the mock server.
- Integration test files run **serially** (`fileParallelism: false`); unit tests timeout 5 s, integration 15 s.
- `beforeEach` in integration setup deletes all `chk:*` keys from Redis — prevents cross-test contamination (also clears `chk:idem:*`, `chk:ref:*`).
- `tests/helpers/app.helper.ts`: `createTestApp()` (singleton `buildApp()`) + `registerTestGateway()` (registers Razorpay, swallows errors) — does **not** call `initialise()`.
- Env vars must be set at **top level** of setup files — `config/index.ts` parses env at import time.
- Run order: `npm run test:unit && npm run test:integration && npm run verify:telemetry`
- The OTel SDK never starts under vitest (`NODE_ENV=test`) — never import `src/telemetry/tracing` or `server.ts` from a test. Telemetry wiring is tested end to end by `verify:telemetry`, not by vitest.

## Architecture
- **Express 5** app, `"type": "module"` in package.json (ESM sources, CommonJS output via `tsc`; `tsx` bridges the gap at dev time).
- Entry: preload `src/telemetry/tracing` (dotenv → OTel SDK → `/metrics` listener) → `src/server.ts` (imports `./telemetry` **first**, same instance) → `src/bootstrap.ts` (dotenv) → `configureLogger(config)` → `verifyTelemetry()` (scrapes own `/metrics`, refuses to boot without `checkoutos_build_info`) → `src/app.ts` (`initialise()` then `buildApp()`) → `listen`. SIGTERM/SIGINT trigger graceful shutdown (close server → disconnect Redis → `shutdownTelemetry()`, 10 s force-exit).
- `initialise()` calls `registerGateways()` then `connectRedis()` — failure exits the process.
- `buildApp()` is a pure factory with no side effects; safe to call in tests.
- Layer: routes → (middleware) → controllers → services → `getActiveGateway()` (GatewayPlugin) + stores (Redis).
- `@` path alias is declared in `vitest.config.ts` but does **not** resolve inside the `unit`/`integration` projects — tests use relative `../../../src/...` imports. `src/` itself uses relative imports — keep it that way (tsc has no `paths` configured).
- Body parsing order in `src/app.ts`: request logger → `express.raw()` for `/webhooks/razorpay` → `express.urlencoded()` for `/webhooks/paytm` → mount webhook router → `express.json()` for all other routes → routes → `notFoundHandler` → `errorHandler` (last). **Order is load-sensitive.**
- `src/middleware/request-logger.ts` is empty — request logging is inline in `buildApp()`.
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
- `src/gateways/gateway.registry.ts` — single source of truth for supported gateway names, required env keys, credential key maps, and base URLs (+ `*_BASE_URL` override). It must never import `config/index.ts` or read `process.env`. Adding a gateway = registry entry + `switch` case + plugin; no service/controller changes.
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
- Relay payload uses `chk_` IDs — raw gateway IDs are never forwarded.

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

`LoggerSettings` also carries optional `env`, `version` and `format`. Every record gets `service: 'checkoutos'` plus `env`/`version` via `defaultMeta`. The pretty format strips those base fields. `format` (from `LOG_FORMAT`) overrides the default of pretty in development, JSON otherwise. Each call re-applies everything, so an omitted field resets to its default. Extend these settings when the logger needs a new value — don't import `config` or `config/runtime.ts`.

## Linting & formatting
- All `**/*.ts`: `no-floating-promises: error`, `no-unused-vars` (args prefixed `_` ignored). Uses `typescript-eslint` recommended + strict.
- `src/**/*.ts`: `no-explicit-any: error`, `explicit-function-return-type: error` (no exceptions — `allowExpressions: false`), `import/no-default-export: error`.
- `src/app.ts` is the **only** production file allowed a default export (config files and `vitest.*.ts` are also exempt).
- `tests/`: `explicit-function-return-type`, `no-non-null-assertion`, `ban-ts-comment`, `no-unused-vars` all off.
- `mocks/`: `no-explicit-any` and `explicit-function-return-type` off.
- Prettier: single quotes, semicolons, trailing commas, 100 print width.
- `dist/` and `coverage/` are ignored. `scripts/**/*.mjs` and `src/**/*.mjs` get Node globals.
- `import/no-restricted-paths` guards the telemetry boundaries (see Architecture Rules → Telemetry).
- Pre-commit: husky runs `npx lint-staged` (`eslint --fix && prettier --write` on staged `*.{ts,js}`). Hooks install via the `prepare` script.

## Env config
- `src/config/env.schema.ts` Zod schema validates env at **module load time**; invalid config → `process.exit(1)` with a formatted error list.
- Required always: `ACTIVE_GATEWAY`, `REDIS_URL` (`redis://` or `rediss://`), `WEBHOOK_RELAY_URL` (http/https). `NODE_ENV` defaults to `development`, `PORT` to 3000 (must be 1024–65535).
- Optional overrides: `RAZORPAY_BASE_URL`, `PAYTM_BASE_URL`, `PAYTM_WEBSITE_NAME`. `PAYU_BASE_URL` / `CASHFREE_BASE_URL` are read by the registry but are not in the Zod schema.
- `BASE_URL` is **not** Zod-validated — read directly via `process.env.BASE_URL` in `config/index.ts` (defaults to `http://localhost:3000`). Set it explicitly in production.
- Observability (all optional, ADR 003): `APP_VERSION` (default `0.0.0`), `LOG_FORMAT` (`json`|`pretty`), `METRICS_PORT` (default 9464, 1024–65535, must differ from `PORT`), `METRICS_AUTH_TOKEN` (non-empty when set). `src/config/runtime.ts` `loadRuntime()` reads the same variables early, without validation, for `src/telemetry/`. Invalid values still fail startup in Zod.
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
- `docker compose --profile mock up` — **will fail**: references `Dockerfile.mock` which does not exist.
- `docker/Dockerfile` and `docker/docker-compose.yml` are empty stubs.

## Known issues / gotchas
- `src/server.ts` has a `console.log('ENV DEBUG:', ...)` that logs `ACTIVE_GATEWAY`, `REDIS_URL`, `WEBHOOK_RELAY_URL` on every startup — an info leak in production.
- `src/gateways/razorpay/razorpay.plugin.ts` uses `console.error` / `console.log` in `extractRazorpayErrorReason()` and `createRefund()` instead of the logger.
- `src/controllers/checkout.controller.ts` imports `getActiveGateway()` directly — a violation of the "controllers have no gateway access" rule. Prefer moving it into `checkout.service.ts` when touching that code.
- `src/services/health.service.ts` imports `pingRedis` straight from `store/redis.client.ts`, although that file says services must not import it directly.
- `vitest.setup.integration.ts` commits Razorpay test-mode credentials and points integration tests at the real sandbox (see Testing).
- `README.md` still lists only Razorpay/PayU/Cashfree and is behind the code (no Paytm, no idempotency).
- `src/middleware/request-logger.ts`, `gateway.interface.ts`, `src/gateways/index.ts`, PayU/Cashfree files, and `helpers/docs/*.md` are empty.
- Refund creation has no idempotency yet (planned for V1.2).
- 9 integration tests fail on the current tree, independent of telemetry (reproduced on `ffdc74c`): 8 in `idempotency.test.ts` (Razorpay sandbox order creation returns 502) and `paytm.webhook.api.test.ts` "returns 401 when CHECKSUMHASH is invalid" (gets 200).
