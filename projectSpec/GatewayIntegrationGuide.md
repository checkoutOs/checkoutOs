# checkoutOs Architecture Layers
## Build Steps — V1.0

---

## Step 1 — Define Types

The first step is defining all core TypeScript types that will be used across the system. These types act as the contract between different layers of the application and ensure type safety throughout the codebase.

- Payment types
- Refund types
- Gateway types
- Status enums
- API response types

Defining types early ensures that every layer communicates using consistent, well-defined structures.

### payment.types.ts

- `GatewayName` is an extensible `string` type — valid gateway names are enforced by the gateway registry, not hardcoded here
- `PaymentStatus` enum with 8 states: `PENDING`, `PROCESSING`, `SUCCESS`, `FAILED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `CANCELLED`, `EXPIRED`
- `RefundStatus` enum with 4 states: `PENDING`, `PROCESSING`, `SUCCESS`, `FAILED`
- Amount stored in paise throughout the entire system
- Separate `StoredPayment` and `StoreRefund` types for Redis — never returned to API clients directly
- `StoredPayment` holds both `gatewayOrderId` (set at creation) and `gatewayPaymentId` (set after webhook) as separate fields

### gateway.types.ts

Defines the gateway abstraction interfaces:

- `GatewayPlugin` — the contract every gateway plugin must implement
- `GatewayMapper<TRawPayment, TRawRefund>` — the contract every gateway mapper must implement
- `WebhookEvent` — normalized webhook shape; `gatewayPaymentId` is used for Redis reverse lookup
- `GatewayPaymentResult` — includes both `gatewayId` and `gatewayOrderId` as separate optional fields

### common.types.ts

Defines:
- `ApiResponse<T>` — union of `ApiSuccessResponse<T>` and `ApiErrorResponse`
- `ErrorCode` — centralized registry of all error code strings; every `AppError` subclass references a value from this object

---

## Step 2 — Errors Layer

The system follows a structured error propagation model.

### Error Flow

```
Gateway throws → Service enriches → Controller maps → Middleware formats
```

- **Gateway Layer** throws typed errors (`GatewayTimeoutError`, `GatewayMappingError`, etc.)
- **Service Layer** enriches errors with domain context
- **Controller Layer** maps errors to HTTP semantics
- **Middleware** formats the final API response

This layered approach ensures consistent error handling and clean separation between business logic and HTTP concerns.

### Error Files

| File | Responsibility |
|---|---|
| `app.errors.ts` | `AppError` abstract base class — all errors extend this |
| `gateways.errors.ts` | `GatewayTimeoutError`, `GatewayUnavailableError`, `GatewayInvalidSignatureError`, `GatewayMappingError` |
| `payment.errors.ts` | `PaymentNotFoundError`, `PaymentFailedError`, `PaymentCreationFailedError`, `InvalidAmountError`, `RefundNotAllowedError`, `RefundNotFoundError`, `RefundAmountExceedsPaymentError`, `RefundFailedError` |
| `store.errors.ts` | `StoreError` |

### `errors/index.ts` — Barrel File

All error classes are re-exported from `errors/index.ts`. Nothing outside the errors directory imports from individual error files directly. This decouples consumers from the internal file structure.

```typescript
import { GatewayMappingError, PaymentNotFoundError } from '../../errors';
```

### `GatewayMappingError`

Thrown by any `GatewayMapper` when a gateway-native status string has no defined mapping. HTTP status 502. Always `isOperational: false` — this is a system-level contract violation between checkoutOs and the gateway, not a client error. Recovery requires adding an explicit mapping in the mapper and redeploying.

---

## Step 3 — Utils Layer

The Utils Layer contains pure functions with zero dependencies on any other part of the system.

- No imports from config
- No imports from store
- No imports from services
- No imports from errors

### ID Generation (`id.ts`)

```
chk_{uuid_v4_without_dashes}  → payment IDs
ref_{uuid_v4_without_dashes}  → refund IDs
```

### Timestamps (`time.ts`)

Every stored record and API response contains `createdAt` and `updatedAt` as ISO 8601 strings. Centralizing timestamp generation ensures consistent formatting across the entire codebase.

### Response Helpers (`response.ts`)

Provides a generic success wrapper for API responses:

```typescript
success<T>(data: T)  // wraps data in ApiSuccessResponse<T>
```

---

## Step 4 — Config Layer

### What the Config Layer Does

Single responsibility:
1. Read environment variables from `process.env`
2. Validate them against a strict Zod schema
3. Export a single typed configuration object

After this step, no file in the codebase directly accesses `process.env`.

### Environment Variables

| Variable | Type | Rule |
|---|---|---|
| `NODE_ENV` | enum | `development` / `production` / `test` |
| `PORT` | number | default 3000 |
| `ACTIVE_GATEWAY` | string | validated against gateway registry |
| `REDIS_URL` | string | must start with `redis://` or `rediss://` |
| `WEBHOOK_RELAY_URL` | string | must be a valid URL |
| `RAZORPAY_KEY_ID` | string | required when `ACTIVE_GATEWAY=razorpay` |
| `RAZORPAY_KEY_SECRET` | string | required when `ACTIVE_GATEWAY=razorpay` |
| `RAZORPAY_WEBHOOK_SECRET` | string | required when `ACTIVE_GATEWAY=razorpay` |
| `RAZORPAY_BASE_URL` | string | optional URL override for mock server |

### Config Directory Structure

```
config/
  env.schema.ts   ← Zod schema + superRefine for conditional gateway credential validation
  index.ts        ← parses process.env, exports typed config object
```

### Fail Fast

checkoutOs exits at startup if any required variable is missing or invalid. A clear error message lists every failing variable. No partial startup.

---

## Step 5 — Store Layer

### Store Directory

```
store/
  redis.client.ts
  payment.store.ts
  refund.store.ts
```

### What the Store Layer Does

The Store Layer is the only part of the system that interacts with Redis.

- Services do not talk to Redis directly
- Controllers do not talk to Redis directly
- Gateways do not talk to Redis directly

All system state lives inside Redis.

### Redis Key Structure

```
chk:pay:{chk_id}          ← StoredPayment hash
chk:gw:{gateway}:{gw_id}  ← reverse lookup: gateway ID → chk_ ID
chk:ref:{ref_id}          ← StoreRefund hash
```

### `StoredPayment` Fields

`StoredPayment` holds two distinct gateway ID fields following Option C:

| Field | Set at | Value |
|---|---|---|
| `gatewayOrderId` | `createPayment()` | native order ID (e.g. `order_XXXX`) |
| `gatewayPaymentId` | after `payment.captured` webhook | native payment ID (e.g. `pay_XXXX`) |

`gatewayPaymentId` is empty string at creation. It is updated by the service layer when the webhook confirms payment capture.

---

## Step 6 — Gateway Layer

### Directory Structure

```
src/gateways/
  gateway.registry.ts           ← single source of truth for all gateways
  razorpay/
    razorpay.types.ts           ← raw Razorpay API response shapes
    razorpay.mapper.ts          ← implements GatewayMapper<RazorpayPayment, RazorpayRefund>
    razorpay.plugin.ts          ← implements GatewayPlugin using axios
```

### What the Gateway Layer Does

The Gateway Layer is the only part of the system that communicates with external payment providers. Services call `getActiveGateway()` from the registry — they never import from a gateway folder directly.

### 6.1 — `<gateway>.types.ts`

Defines raw API response shapes for the gateway. These types are gateway-specific and must never leak outside the gateway folder. Includes:

- Raw payment and order response shapes
- Raw refund response shape
- Webhook payload envelope
- Native status string unions (narrow types, not plain `string`)
- API error response shape

**Key rule:** Define separate status union types per entity. `RazorpayOrderStatus`, `RazorpayPaymentStatus`, and `RazorpayRefundStatus` are three distinct types — they must not be mixed.

### 6.2 — `<gateway>.mapper.ts`

Implements `GatewayMapper<TRawPayment, TRawRefund>` as a class. Pure translation only — no HTTP calls, no config access, no Redis.

Key methods:
- `toPaymentResult(raw)` — translates raw payment/order response to `GatewayPaymentResult`; never sets `paymentUrl` (requires credentials)
- `toRefundResult(raw)` — translates raw refund response to `GatewayRefundResult`
- `toUnifiedStatus(gatewayStatus)` — throws `GatewayMappingError` on unknown status (no fallback)
- `toUnifiedRefundStatus(gatewayStatus)` — separate method; refund and payment status spaces are disjoint

**`exactOptionalPropertyTypes` compliance:** Use conditional spreading for optional fields:
```typescript
...(raw.description !== undefined && { description: raw.description })
```

### 6.3 — `<gateway>.plugin.ts`

Implements `GatewayPlugin`. All HTTP calls via axios. Mapper is instantiated in the constructor.

**Config interface (separate credentials from infrastructure):**
```typescript
interface RazorpayCredentials {
  keyId: string; keySecret: string; webhookSecret: string;
}
interface RazorpayConfig {
  credentials: RazorpayCredentials;
  baseUrl: string; // injected — never hardcoded
}
```

**`baseUrl` injection:** The plugin never hardcodes the API base URL. It receives `baseUrl` via `RazorpayConfig` from the registry. In production this is the real Razorpay URL. In development/CI, set `RAZORPAY_BASE_URL=http://localhost:9090` to point at the mock server.

**Webhook signature verification:** Always uses `crypto.timingSafeEqual` — never string equality. Verification is the first operation in `parseWebhookEvent()`. Status is derived from the event string, not the entity status field.

**Error handling:** Every HTTP call converts axios errors to typed `AppError` subclasses. Raw axios errors never propagate to the service layer.

**`healthCheck()`:** Never throws. Returns `{ healthy: false }` on any failure.

**`orderToPayment()` private adapter:** Razorpay requires an order before a payment. This private method adapts `RazorpayOrder` → `RazorpayPayment` shape so `toPaymentResult()` handles both without a separate mapper method. Uses `mapOrderStatusToPaymentStatus()` with an explicit return type and exhaustiveness guard.

### 6.4 — `gateway.registry.ts`

Single source of truth for all gateways. Exports:

| Export | Consumed by |
|---|---|
| `supportedGateways` | `env.schema.ts` for `ACTIVE_GATEWAY` validation |
| `gatewayEnvDefinitions` | `env.schema.ts` for conditional credential validation |
| `gatewayCredentialEnvKeys` | `config/index.ts` via `buildActiveGatewayCredentials()` |
| `registerGateways(env, gateway)` | `app.ts` at startup — instantiates the active plugin |
| `getActiveGateway()` | Service layer — returns the registered `GatewayPlugin` |
| `buildActiveGatewayCredentials()` | `config/index.ts` |
| `isSupportedGatewayName()` | Utility |

**`registerGateways()`** is called once at startup after config validation. It reads credentials and `baseUrl` from the validated env object, instantiates the active plugin via the factory function, and stores it in the plugin map.

**`getActiveGateway()`** throws `GatewayUnavailableError` if called before `registerGateways()`. The error surfaces on the first request — not silently.

**Adding a new gateway to the registry:**
1. Add name to `supportedGateways`
2. Add entry to `gatewayEnvDefinitions` (with `requiredEnvKeys`, `defaultBaseUrl`, `baseUrlEnvKey`)
3. Add entry to `gatewayCredentialEnvKeys`
4. Add a `case` to `registerGateways()` switch — remove the existing `TODO` throw
5. Import the factory function from the new plugin file

### 6.5 — Startup Wiring

`registerGateways()` must be called in `app.ts` or `server.ts` after config is validated:

```typescript
import { config } from './config';
import { registerGateways } from './gateways/gateway.registry';
import type { SupportedGatewayName } from './gateways/gateway.registry';

registerGateways(
  process.env as Record<string, unknown>,
  config.gateway.active as SupportedGatewayName,
);
```

---

## Build Sequence Summary

| Step | Layer | Depends On |
|---|---|---|
| 1 | types | nothing |
| 2 | errors | types |
| 3 | utils | types |
| 4 | config | types, gateway registry (for validation) |
| 5 | store | types, errors, config |
| 6 | gateways | types, errors, config |
| 7 | services | types, errors, config, store, gateways |
| 8 | controllers | types, errors, services |
| 9 | routes + app | controllers, gateway registry (for startup) |
| 10 | server | app |