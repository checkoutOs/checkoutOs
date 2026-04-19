# checkoutOs
## Contributor Guide — Foundation (Steps 1–6)
### Version V1.1 — Gateway Layer Complete

A redirect-based · SDK-less HTTP API · Redis-backed  
Unified Payment Gateway Abstraction for India

---

## 1. Stack

- Node.js
- TypeScript (strict mode + `exactOptionalPropertyTypes`)
- Express
- Redis
- axios (HTTP client for gateway communication)

---

## 2. Gateways

- Razorpay (V1.0 — implemented)
- PayU (V1.x — registry stub, plugin pending)
- Cashfree (V1.x — registry stub, plugin pending)

---

## 3. What is checkoutOs?

Every payment gateway in India ships its own SDK, uses different naming conventions, exposes different status strings, and has unique integration quirks. Teams that integrate one provider get locked in — switching later means rewriting core payment logic.

checkoutOs solves this with a single stable HTTP API that wraps native gateway SDKs behind a unified contract. Teams can switch providers by changing a single environment variable.

### Core Principles

- **Correctness over convenience** — payment state must always be accurate
- **Explicit over implicit** — no magic, no hidden behaviour
- **Contracts over assumptions** — every layer has a typed interface
- **Guardrails over trust** — fail fast, validate everything at startup
- **Infrastructure-grade discipline** — this system handles real money

---

## 4. V1.0 Scope

Version 1.0 is redirect-based and SDK-less.

| Decision | Choice | Why |
|---|---|---|
| Checkout Type | Redirect-based only | No PCI-DSS required |
| Integration Style | SDK-less HTTP API | Any client, any language |
| State Store | Redis | Persistent, multi-instance safe |
| HTTP Client | axios | Typed, timeout-enforced, mock-server compatible |

---

## 5. How a Payment Works

1. Client calls `POST /payments`
2. checkoutOs creates payment on the active gateway
3. checkoutOs returns `{ paymentId, paymentUrl, status }`
4. Client redirects user to `paymentUrl`
5. Gateway fires webhook to checkoutOs
6. checkoutOs normalises and relays webhook to developer

> **Note:** Developers only see checkoutOs IDs (`chk_...`). Gateway-native IDs are stored internally in Redis.

---

## 6. Prerequisites & Getting Started

### System Requirements

| Tool | Requirement |
|---|---|
| Node.js | v18 or higher (v20 recommended) |
| npm | Included with Node.js |
| Redis | v6 or higher |
| TypeScript | Strict mode |
| Git | Any recent version |

### Initial Setup

```bash
git clone https://github.com/your-org/checkoutos.git
cd checkoutos
npm install
cp .env.example .env
```

Start Redis:
```bash
docker run -d -p 6379:6379 redis:7-alpine
```

Start development server:
```bash
npm run dev
```

Start mock gateway server (for local development without real credentials):
```bash
npm run mock:gateway
```

---

## 7. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `development` / `production` / `test` |
| `PORT` | No | HTTP server port (default: 3000) |
| `ACTIVE_GATEWAY` | Yes | `razorpay` / `payu` / `cashfree` |
| `REDIS_URL` | Yes | Redis connection string |
| `WEBHOOK_RELAY_URL` | Yes | Developer webhook endpoint |
| `RAZORPAY_KEY_ID` | Conditional | Required when Razorpay active |
| `RAZORPAY_KEY_SECRET` | Conditional | Required when Razorpay active |
| `RAZORPAY_WEBHOOK_SECRET` | Conditional | Required when Razorpay active |
| `RAZORPAY_BASE_URL` | No | Override Razorpay API URL (use for mock server) |

`RAZORPAY_BASE_URL` defaults to `https://api.razorpay.com/v1` when omitted. Set it to `http://localhost:9090` (or your `MOCK_PORT`) to use the local mock server without changing any code.

---

## 8. Directory Structure

```
checkoutos/
  src/
    app.ts
    server.ts
    config/
      env.schema.ts
      index.ts
    types/
      payment.types.ts
      gateway.types.ts
      common.types.ts
    errors/
      index.ts              ← barrel file — import all errors from here
      app.errors.ts
      gateways.errors.ts
      payment.errors.ts
      store.errors.ts
    utils/
    store/
    gateways/
      gateway.registry.ts   ← single source of truth for all gateways
      razorpay/
        razorpay.types.ts
        razorpay.mapper.ts
        razorpay.plugin.ts
    services/
    controllers/
    routes/
    middleware/
  tests/
  mocks/
    gateways/
      razorpay/
        handlers.ts
    server.ts
  docs/
  .env.example
  package.json
```

---

## 9. Layer Responsibilities

| Layer | Responsibility |
|---|---|
| `controllers` | HTTP parsing and response sending only |
| `services` | Business logic and orchestration |
| `gateways` | Gateway SDK/HTTP encapsulation + response translation |
| `store` | Redis persistence and ID mapping |
| `middleware` | Logging, errors, request lifecycle |
| `types` | Shared TypeScript interfaces |
| `errors` | Typed error classes — all extend `AppError` |
| `utils` | Pure helper functions |
| `config` | Environment validation and config export |

---

## 10. Build Sequence

| Step | Layer | Reason |
|---|---|---|
| 1 | types | Foundation — nothing depends on nothing |
| 2 | errors | Depends only on types |
| 3 | utils | Depends on types |
| 4 | config | Validates environment; imports from gateway registry for gateway name validation |
| 5 | store | Redis persistence |
| 6 | gateways | Gateway abstraction — types → mapper → plugin → registry |
| 7 | services | Business logic |
| 8 | controllers | API handlers |
| 9 | routes + app | HTTP routing + `registerGateways()` startup call |
| 10 | server | HTTP server startup |

---

## 11. Types Layer

### `payment.types.ts`

- `PaymentStatus` enum: `PENDING`, `PROCESSING`, `SUCCESS`, `FAILED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `CANCELLED`, `EXPIRED`
- `RefundStatus` enum: `PENDING`, `PROCESSING`, `SUCCESS`, `FAILED`
- `GatewayName` is an extensible `string` — valid names enforced by the gateway registry
- Amount stored in paise throughout
- `StoredPayment` holds `gatewayOrderId` and `gatewayPaymentId` as separate fields (see Section 16)

### `gateway.types.ts`

- `GatewayPlugin` — every gateway plugin implements this interface
- `GatewayMapper<TRawPayment, TRawRefund>` — every gateway mapper implements this interface
- `WebhookEvent.gatewayPaymentId` — used for Redis reverse lookup
- `GatewayPaymentResult` — includes both `gatewayId` and `gatewayOrderId`

### `common.types.ts`

- `ApiResponse<T>` — union type, controllers return this
- `ErrorCode` — centralized registry; every `AppError` subclass references a value from here

---

## 12. Errors Layer

All error classes extend `AppError`. The `AppError` base class carries:
- `httpStatus` — abstract, defined by each subclass
- `code` — from `ErrorCode` registry
- `details` — structured context for the error middleware
- `isOperational` — `true` for client errors, `false` for system failures

### Import Rule

Always import from the barrel file:
```typescript
import { GatewayMappingError, PaymentNotFoundError } from '../../errors';
```

Never import from individual error files directly.

---

## 13. Utils Layer

Pure functions with zero side effects and zero dependencies on other layers.

- `generatePaymentId()` → `chk_{uuid}`
- `generateRefundId()` → `ref_{uuid}`
- `now()` → ISO 8601 timestamp
- `success<T>(data)` → `ApiSuccessResponse<T>`

---

## 14. Config Layer

- Only `config/env.schema.ts` and `config/index.ts` read `process.env`
- Startup validation via Zod — process exits with a clear error message on misconfiguration
- Structured config object: `config.gateway.active`, `config.redis.url`, `config.webhook.relayUrl`
- Gateway credential validation is conditional — only the active gateway's credentials are required

---

## 15. Store Layer

The only layer that interacts with Redis. Services, controllers, and gateways never access Redis directly.

### Redis Key Structure

```
chk:pay:{chk_id}           ← StoredPayment hash
chk:gw:{gateway}:{gw_id}   ← reverse lookup map
chk:ref:{ref_id}           ← StoreRefund hash
```

---

## 16. Gateway Layer (Step 6)

### Architecture Overview

The gateway layer follows a **registry-driven plugin architecture**. The service layer calls `getActiveGateway()` — it never imports from a gateway folder directly.

```
Service layer
  ↓ getActiveGateway()
gateway.registry.ts
  ↓ returns registered GatewayPlugin
razorpay.plugin.ts
  ↓ axios HTTP call to Razorpay
  ↓ passes raw response to mapper
razorpay.mapper.ts
  ↓ returns unified GatewayPaymentResult
Back to service layer
```

### Gateway ID Strategy (Option C)

Razorpay (and any gateway that separates order creation from payment) uses two distinct IDs:

| ID | Format | When assigned | Stored as |
|---|---|---|---|
| Order ID | `order_XXXX` | At `createPayment()` | `gatewayOrderId` |
| Payment ID | `pay_XXXX` | After user completes payment (via webhook) | `gatewayPaymentId` |

`gatewayPaymentId` is empty at creation time. It is updated by the service layer when the `payment.captured` webhook arrives. The service layer then passes `gatewayPaymentId` directly to `createRefund()` — the plugin makes a single API call with no internal ID resolution.

### `gateway.registry.ts`

| Export | Purpose |
|---|---|
| `supportedGateways` | Consumed by `env.schema.ts` for `ACTIVE_GATEWAY` validation |
| `gatewayEnvDefinitions` | Drives conditional credential validation in `env.schema.ts`; includes `defaultBaseUrl` and `baseUrlEnvKey` per gateway |
| `gatewayCredentialEnvKeys` | Maps logical field names to env var names; consumed by `buildActiveGatewayCredentials()` |
| `registerGateways(env, gateway)` | Called once at startup; instantiates the active plugin |
| `getActiveGateway()` | Returns the registered plugin; throws if called before `registerGateways()` |
| `buildActiveGatewayCredentials()` | Consumed by `config/index.ts` |

### Startup Wiring

`registerGateways()` must be called in `app.ts` after config validation:

```typescript
import { config } from './config';
import { registerGateways } from './gateways/gateway.registry';
import type { SupportedGatewayName } from './gateways/gateway.registry';

registerGateways(
  process.env as Record<string, unknown>,
  config.gateway.active as SupportedGatewayName,
);
```

### Mock Server

The mock server (`npm run mock:gateway`) uses MSW to intercept gateway HTTP calls. Set `RAZORPAY_BASE_URL=http://localhost:9090` to point the plugin directly at the mock server for unit tests without MSW running as a separate process.

---

## 17. Adding a New Gateway

Steps:

1. Create `src/gateways/<gateway>/<gateway>.types.ts` — raw response shapes
2. Create `src/gateways/<gateway>/<gateway>.mapper.ts` — implements `GatewayMapper`
3. Create `src/gateways/<gateway>/<gateway>.plugin.ts` — implements `GatewayPlugin`
4. Add to `gateway.registry.ts`:
   - `supportedGateways` array
   - `gatewayEnvDefinitions` entry (with `requiredEnvKeys`, `defaultBaseUrl`, `baseUrlEnvKey`)
   - `gatewayCredentialEnvKeys` entry
   - `case` in `registerGateways()` switch — remove the `TODO` throw
5. Add credential env vars to `env.schema.ts`
6. Update `.env.example`
7. Create mock server handlers in `mocks/gateways/<gateway>/handlers.ts`
8. Register handlers in `mocks/server.ts`

See `docs/GatewayIntegrationGuide.md` for the full step-by-step guide with code patterns, common mistakes, and a testing checklist.

---

## 18. TypeScript Rules

checkoutOs uses `strict: true` with `exactOptionalPropertyTypes: true`.

| Rule | Reason |
|---|---|
| No `any` | Prevent hidden bugs — ESLint enforces this |
| Explicit return types | Clear contracts on all public functions |
| No floating promises | Prevent silent async failures |
| No default exports | Explicit imports only |
| `exactOptionalPropertyTypes` | Optional fields typed as `?: string` cannot be set to `undefined` — use conditional spread |

---

## 19. Branch Naming

| Prefix | Usage |
|---|---|
| `feature/` | New functionality |
| `fix/` | Bug fixes |
| `refactor/` | Code restructuring |
| `docs/` | Documentation changes |
| `chore/` | Maintenance tasks |

---

## 20. Testing Philosophy

Tests focus on protecting business invariants.

Priority areas:
- Gateway status mapping — `toUnifiedStatus()` and `toUnifiedRefundStatus()`
- `GatewayMappingError` thrown on unknown status strings
- ID generation correctness
- Redis mapping round-trips
- Webhook signature verification (valid + invalid cases)
- Webhook correlation logic
- Refund validation edge cases

---

## 21. Out of Scope for V1.0

| Feature | Target Version |
|---|---|
| API-based card capture | Future version |
| Native mobile SDKs | Future version |
| UPI deep links | Future version |
| Webhook retry / DLQ | V1.2 |
| JWT authentication | V1.2 |
| Auto gateway failover | V1.2 |