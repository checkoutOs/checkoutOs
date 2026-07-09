# checkoutOs — Agent Guide

name: checkoutos
description: checkoutOs is a redirect-based, SDK-less HTTP API payment orchestration system that provides a unified interface for Indian payment gateways (Razorpay, PayU, Cashfree). It handles payment creation, status polling, webhook processing, and refunds with Redis-backed state management.

# Purpose
You are an expert contributor for checkoutOs.

Before writing code , always consult the project documentation inside the docs folder.

## Project 

checkoutOs is an infrastructure-grade payment orchestration system.

The architecture is plugin-based.

Supported gateways.
- Razorpay
- PayU
- Cashfree
- paytm

Never break architectural contracts.

---
#Architecture Rules

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

---

# Gateway Rules

Every new gateway must include

- types
- mapper
- plugin
- tests
- registration
- webhook verification

Never modify service architecture to support one gateway.

Gateway-specific behavior stays inside the plugin.

---

# When implementing features

Before coding:

1. Determine affected layers.
2. Follow project contracts.
3. Preserve backward compatibility.
4. Add tests.
5. Update documentation.

---


## Quick start (local dev)
```bash
cp .env.example .env
docker run -d --name checkoutos-redis -p 6379:6379 redis:7-alpine
npm run mock:gateway    # MSW mock Razorpay on :9090
npm run dev             # tsx watch src/server.ts on :3000
```

## Commands
| Command | What it does |
|---------|-------------|
| `npm run dev` | Dev server with hot-reload via `tsx watch` |
| `npm run build` | `tsc` → `dist/` |
| `npm start` | Run compiled `dist/server.js` |
| `npm run typecheck` | `tsc --noEmit` — strict mode |
| `npm run mock:gateway` | MSW mock Razorpay server on :9090 |
| `npm run test:unit` | Vitest `unit` project — no Redis needed |
| `npm run test:integration` | Vitest `integration` project — Redis required |
| `npm run test:coverage` | Coverage (lines 70%, funcs 70%, branches 60%) |
| `npm run test:watch` | Watch mode (unit only) |

**`npm test` is a dead placeholder (exit 1). Never use it.**

## Testing
- **Unit tests** (`tests/unit/`): `ioredis` → `ioredis-mock` via `vi.mock()` in `vitest.setup.unit.ts`; logger silenced; no external services.
- **Integration tests** (`tests/integration/`): Real Redis at `localhost:6379` required. `axios` is **not** globally mocked — tests hit a real mock server (default `http://localhost:9090`). Must run `npm run mock:gateway` first for gateway calls to succeed.
- Integration test files run **serially** (`fileParallelism: false`); unit tests timeout 5 s, integration 15 s.
- `beforeEach` in integration setup flushes all `chk:*` keys from Redis — prevents cross-test contamination.
- `tests/helpers/app.helper.ts`: `createTestApp()` (singleton `buildApp()`) + `registerTestGateway()` — does **not** call `initialise()`.
- Run order: `npm run test:unit && npm run test:integration`

## Architecture
- **Express 5** app, `"type": "module"` in package.json (ESM sources, CommonJS output via `tsc`; `tsx` bridges the gap at dev time).
- Entry: `src/server.ts` → `src/bootstrap.ts` (dotenv) → `src/app.ts` (`initialise()` then `buildApp()`).
- `initialise()` calls `registerGateways()` then `connectRedis()` — failure exits the process.
- `buildApp()` is a pure factory with no side effects; safe to call in tests.
- Layer: routes → controllers → services → `getActiveGateway()` (GatewayPlugin) + stores (Redis).
- `@` path alias resolves to `./src` (configured in `vitest.config.ts`; use `@/config`, `@/utils/logger`, etc.).
- Body parsing order in `src/app.ts`: `express.raw()` for `/webhooks/razorpay` → `express.urlencoded()` for `/webhooks/paytm` → mount webhook router → `express.json()` for all other routes. **Order is load-sensitive.**
- Payment IDs: `chk_` prefix. Refund IDs: `ref_` prefix. Amounts in **paise** (₹500 = 50000). Only `INR` supported.
- Redis key patterns: `chk:pay:{chk_id}` (hash), `chk:gw:{gateway}:{gw_id}` (reverse lookup string).
- `GET /checkout/:chkId` serves **HTML** (Razorpay JS SDK page), not JSON.

## Gateways
- **Razorpay**: fully implemented (`src/gateways/razorpay/razorpay.plugin.ts`, ~440 lines), registered in registry.
- **Paytm**: fully implemented (`src/gateways/paytm/paytm.plugin.ts`, ~485 lines, `createPaytmPlugin()` exists) but **NOT wired into `gateway.registry.ts`** — the switch case still throws. Registering it only requires calling `createPaytmPlugin()` there.
- **PayU, Cashfree**: plugin files are **empty**; registry throws at registration for both.
- `src/gateways/gateway.registry.ts` — single source of truth for supported gateway names, env keys, and base URLs. Adding a gateway = registry entry + plugin file only; no service/controller changes needed.
- Services never import gateway folders directly — always call `getActiveGateway()`.
- `ACTIVE_GATEWAY` env var selects the active gateway; Zod `superRefine` makes its credentials required at startup.

## Payment flow invariants
- `gatewayOrderId` set at payment creation; `gatewayPaymentId` (e.g. `pay_XXXX`) starts as `''` and is backfilled **only when a webhook arrives**.
- Polling (`getPaymentStatus`) never transitions to SUCCESS — that path is webhook-only.
- Refunds require a non-empty `gatewayPaymentId` (webhook must precede any refund).
- Partial refunds stack: a PARTIALLY_REFUNDED payment can receive further refunds.
- Valid webhook status transitions (invalid transitions are silently ignored, not errors):
  - `PENDING` → PROCESSING, SUCCESS, FAILED, CANCELLED, EXPIRED
  - `PROCESSING` → SUCCESS, FAILED, CANCELLED, EXPIRED
  - SUCCESS / FAILED / CANCELLED / EXPIRED / REFUNDED / PARTIALLY_REFUNDED → (terminal, no transitions)
- Webhook relay to `WEBHOOK_RELAY_URL` is fire-and-forget (5 s timeout); relay failure logs a warning and does not fail the request.
- Relay payload uses `chk_` IDs — raw gateway IDs are never forwarded.

## TypeScript quirks
- Targets ES2021, emits CommonJS (`tsc`); `tsx` handles ESM→CJS at dev time.
- Strict flags that trip agents: `noUncheckedIndexedAccess` (indexed access returns `T | undefined`), `exactOptionalPropertyTypes` (can't assign `undefined` to optional props), `noImplicitReturns` (all code paths must return).
- `rootDir: "src"` — only `src/` is compiled by `tsc`; tests/mocks are excluded from build.
- ESLint uses `tsconfig.eslint.json` (not `tsconfig.json`) to widen `rootDir` to `.` for type-checking tests and mocks.

## Linting & formatting
- `src/**/*.ts`: `no-explicit-any: error`, `explicit-function-return-type: error` (no exceptions — `allowExpressions: false`), `import/no-default-export: error`.
- `src/app.ts` is the **only** production file allowed a default export.
- `tests/`, `mocks/`: `explicit-function-return-type: off`, `no-non-null-assertion: off`.
- Prettier: single quotes, semicolons, trailing commas, 100 print width.
- Pre-commit: husky + lint-staged (`eslint --fix && prettier --write`) is configured in `package.json` but **`.husky/` has no hook files** — pre-commit linting is NOT active.

## Env config
- `src/config/env.schema.ts` Zod schema validates env at **module load time**; invalid config → `process.exit(1)`.
- `BASE_URL` is **not** Zod-validated — read directly via `process.env.BASE_URL` in `config/index.ts` (defaults to `http://localhost:3000`). Set it explicitly in production.
- `config` object groups: `config.gateway.active`, `config.gateway.credentials`, `config.redis.url`, `config.webhook.relayUrl`, `config.app.baseUrl`.

## Mock server (`npm run mock:gateway`)
- MSW-based HTTP server on port 9090 (override via `MOCK_PORT`).
- Only mocks Razorpay (`POST /v1/orders`). No other gateways mocked.
- Deterministic: no randomness, `created_at` always `1705314600`, order IDs derived from receipt.
- Auth is validated (401 on wrong/missing Basic Auth credentials).
- Test creds: `RAZORPAY_KEY_ID=rzp_test_mockKeyId00001`, `RAZORPAY_KEY_SECRET=mockSecret00001`.
- Add a gateway: create `mocks/gateways/<gateway>/handlers.ts`, spread into `mocks/server.ts`.

## Docker
- `docker compose up` starts app + Redis.
- `docker compose --profile mock up` — **will fail**: references `Dockerfile.mock` which does not exist in the repo.
- Docker Compose overrides `REDIS_URL` to `redis://redis:6379` (container service name).
- Production image: multi-stage, non-root `checkoutos` user (uid/gid 1001), healthcheck on `/health`.
- `docker/Dockerfile` and `docker/docker-compose.yml` exist but are empty stubs.

## Known issues / gotchas
- `src/server.ts` has a `console.log('ENV DEBUG:', ...)` on lines 24-28 that logs `ACTIVE_GATEWAY`, `REDIS_URL`, `WEBHOOK_RELAY_URL` on every startup — an info leak in production.
- `src/gateways/razorpay/razorpay.plugin.ts` uses `console.error` / `console.log` in `extractRazorpayErrorReason()` and `createRefund()` instead of the logger.
- `gateway.interface.ts` and `src/gateways/index.ts` are empty files.
- Paytm `websiteName` is hardcoded to `'WEBSTAGING'` — needs override for production.
- Paytm `getRefundStatus()` always throws `GatewayUnavailableError` (gateway does not support polling refund status).
