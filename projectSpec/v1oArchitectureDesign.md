# checkoutOs — V1.0 Architecture & Design Specification
### Version V1.1 — Gateway Layer Complete

Architecture Characteristics:  
Redirect-based · SDK-less HTTP API · Redis-backed · Registry-driven multi-gateway

---

## 1. Problem Statement

Every payment gateway in India ships its own SDK, uses different naming conventions, exposes different status strings, and has unique integration quirks.

Teams that integrate one provider often get locked in — switching later requires rewriting core payment logic.

checkoutOs solves this with a single, stable HTTP API that wraps native gateway SDKs behind a unified contract, allowing teams to switch providers by changing environment variables alone.

---

## 2. V1.0 Scope & Goals

Version 1.0 establishes the core foundation. The primary objective is correctness and abstraction.

### Payment Flow Integration Style

| Checkout Type | Supported | Notes |
|---|---|---|
| Redirect-based | Yes | Gateway hosts payment UI. checkoutOs returns `paymentUrl` and receives results via webhook. |
| API-based card capture | No | Requires PCI-DSS compliance. |
| SDK-less HTTP API | Yes | Clients interact via REST APIs only. |
| Native mobile SDKs | No | iOS / Android SDKs are out of scope. |
| Standard one-time checkout | Yes | Cards, netbanking, wallets via gateway page. |
| UPI intent / subscriptions | No | Out of scope for V1.0. |

### What Is In Scope

- Payment creation via unified API returning `paymentUrl`
- On-demand payment status checking
- Basic webhook relay to developer-configured endpoint
- Full and partial refunds
- Multi-gateway support via registry (Razorpay implemented; PayU and Cashfree stubs)
- Redis-backed ID store with separate `gatewayOrderId` and `gatewayPaymentId` fields
- Docker-containerized deployment
- OpenAPI + Swagger documentation
- Node.js runtime with TypeScript (strict mode + `exactOptionalPropertyTypes`)

### What Is Explicitly Out of Scope

| Out of Scope | Reason |
|---|---|
| API-based card capture | Requires PCI-DSS certification |
| Native mobile SDKs | Clients use HTTP API + WebView |
| UPI intent / deep links | Requires polling logic |
| Subscriptions / recurring billing | Requires mandates and separate flows |
| Webhook retry / DLQ | Deferred to V1.2 |
| JWT / API key authentication | Deferred to V1.2 |
| Auto gateway failover | Deferred to V1.2 |
| Metrics and dashboards | Deferred to V1.2 |

---

## 3. How the Payment Flow Works

checkoutOs is redirect-based and SDK-less. Every payment follows the same flow regardless of gateway.

### High-Level Flow

1. Client calls `POST /payments`
2. checkoutOs creates payment on gateway
3. checkoutOs returns `paymentUrl`
4. User completes payment on gateway page
5. Gateway fires webhook to checkoutOs
6. checkoutOs normalizes and relays webhook to developer

### Step-by-Step Breakdown

| Step | Actor | Description |
|---|---|---|
| 1 | Client → checkoutOs | Client sends payment request |
| 2 | checkoutOs → Gateway | Creates payment; stores `gatewayOrderId` in Redis |
| 3 | checkoutOs → Client | Returns `paymentId`, `paymentUrl`, and `status` |
| 4 | Client → User | Redirects user to `paymentUrl` |
| 5 | Gateway → checkoutOs | Webhook arrives with native payment ID |
| 6 | checkoutOs → store | Updates `gatewayPaymentId` from `pay_XXXX` in Redis |
| 7 | checkoutOs → Developer | Correlates IDs and relays normalized webhook |

### Why Developers Never See Gateway IDs

Developers only interact with checkoutOs IDs (prefixed with `chk_`). Gateway-native IDs remain internal and are stored in Redis. This enables switching providers without code changes.

---

## 4. Core Design Contracts

### Unified Payment Status Enum

| Status | Meaning | Gateway Equivalents |
|---|---|---|
| `PENDING` | Payment initiated | `created`, `pending` |
| `PROCESSING` | Processing in progress | `authorized`, `processing` |
| `SUCCESS` | Payment completed | `captured`, `success`, `paid` |
| `FAILED` | Payment failed | `failed`, `txn_failure` |
| `REFUNDED` | Full refund | `refunded` |
| `PARTIALLY_REFUNDED` | Partial refund | `partially_refunded` |
| `CANCELLED` | User cancelled | `cancelled`, `userCancelled` |
| `EXPIRED` | Session expired | `expired` |

### Canonical API Response

**`POST /payments` success:**
```json
{
  "success": true,
  "data": {
    "paymentId": "chk_a1b2c3d4",
    "paymentUrl": "https://checkout.razorpay.com/...",
    "status": "PENDING",
    "amount": 50000,
    "currency": "INR",
    "gateway": "razorpay",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

**Error response:**
```json
{
  "success": false,
  "error": {
    "code": "PAYMENT_FAILED",
    "message": "Payment was declined",
    "details": {}
  }
}
```

### `GatewayPlugin` Interface

```typescript
interface GatewayPlugin {
  readonly name: GatewayName;
  createPayment(params: CreatePaymentParams): Promise<GatewayPaymentResult>;
  getPaymentStatus(gatewayId: string): Promise<GatewayPaymentResult>;
  createRefund(params: CreateRefundParams): Promise<GatewayRefundResult>;
  getRefundStatus(gatewayRefundId: string): Promise<GatewayRefundResult>;
  parseWebhookEvent(body: unknown, headers: Record<string, string | string[] | undefined>): WebhookEvent;
  healthCheck(): Promise<GatewayHealthResult>;
}
```

### `GatewayMapper` Interface

```typescript
interface GatewayMapper<TRawPayment, TRawRefund> {
  toPaymentResult(raw: TRawPayment): GatewayPaymentResult;
  toRefundResult(raw: TRawRefund): GatewayRefundResult;
  toUnifiedStatus(gatewayStatus: string): PaymentStatus; // throws on unknown
}
```

### `GatewayName` Type

`GatewayName` is an extensible `string` type derived from the gateway registry rather than a hardcoded union. New gateways are added via `gateway.registry.ts` without modifying core type definitions.

---

## 5. Unified Payment ID Strategy

```
chk_{uuid_v4_without_dashes}  // payments
ref_{uuid_v4_without_dashes}  // refunds
```

The gateway generates a payment. checkoutOs generates the public `chk_` ID.

---

## 6. Gateway ID Management (Option C)

checkoutOs uses **Option C** for managing gateway-native IDs. This was chosen over simpler alternatives because it is the most explicit and aligns with the project's core principles.

### The Two ID Problem

Some gateways (Razorpay) assign two separate IDs:

- **Order ID** (`order_XXXX`) — created upfront when `createPayment()` is called
- **Payment ID** (`pay_XXXX`) — assigned by the gateway after the user completes payment

These are not the same ID and serve different purposes. Conflating them causes silent bugs.

### Option C Behaviour

| Moment | `gatewayOrderId` | `gatewayPaymentId` |
|---|---|---|
| `createPayment()` returns | `order_XXXX` | `""` (empty — not yet assigned) |
| `payment.captured` webhook | unchanged | `pay_XXXX` (updated by service layer) |
| `createRefund()` called | not used | `pay_XXXX` passed by service layer |

The plugin's `createRefund()` receives `pay_XXXX` directly from the service layer and makes a single API call. There is no internal ID resolution inside the plugin.

### `StoredPayment` Schema

```typescript
interface StoredPayment {
  chkId: string;
  gatewayOrderId: string;   // set at createPayment() — order_XXXX
  gatewayPaymentId: string; // set after webhook — pay_XXXX, empty until then
  gateway: string;
  orderId: string;
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
}
```

### Why Not Simpler Options

| Option | Problem |
|---|---|
| Store only `order_XXXX` | Plugin must do two HTTP calls per refund; ambiguous when order has multiple attempts |
| Store only `pay_XXXX` (update on webhook) | `gatewayOrderId` lost; can't poll order status before webhook arrives |
| Option C (both fields) | Explicit, no loss of data, one refund API call, matches `GatewayPaymentResult` shape |

---

## 7. State Management: Stateless API + Redis

checkoutOs is stateless at runtime.

### Stateless Components

- Controllers
- Services
- Business logic
- Gateway plugins

### Stored in Redis

- `chk_` ID → `gatewayOrderId` + `gatewayPaymentId` mapping
- Webhook correlation mapping
- Payment metadata and status
- Refund mappings

### Redis Key Structure

```
chk:pay:{chk_id}           ← StoredPayment hash
chk:gw:{gateway}:{gw_id}   ← reverse lookup: gateway ID → chk_ ID
chk:ref:{ref_id}           ← StoreRefund hash
```

---

## 8. Architecture Layers

| Layer | Responsibility |
|---|---|
| Controllers | HTTP request/response handling |
| Services | Business orchestration |
| Gateways | Raw gateway HTTP calls + response translation |
| Store | Redis abstraction layer |
| Middleware | Cross-cutting concerns |

> **Note:** There is no separate Adapters layer. Translation between gateway-specific and unified models happens inside the gateway folder via the mapper class. This keeps the gateway folder fully self-contained.

---

## 9. Gateway Layer Architecture

### Registry-Driven Plugin Architecture

The gateway registry (`gateway.registry.ts`) is the single source of truth. Services call `getActiveGateway()` — they never import from a gateway folder directly.

### Per-Gateway Folder Structure

```
src/gateways/
  gateway.registry.ts
  razorpay/
    razorpay.types.ts    ← raw API response shapes
    razorpay.mapper.ts   ← implements GatewayMapper
    razorpay.plugin.ts   ← implements GatewayPlugin
```

### Plugin Config Pattern

Every plugin separates credentials from infrastructure configuration:

```typescript
interface RazorpayCredentials {
  keyId: string;       // secret
  keySecret: string;   // secret
  webhookSecret: string; // secret
}

interface RazorpayConfig {
  credentials: RazorpayCredentials;
  baseUrl: string; // not a secret — controls which host the plugin calls
}
```

`baseUrl` defaults to the production gateway URL. Override it via `RAZORPAY_BASE_URL` to point at the mock server for local development or CI.

### HTTP Client

All gateway HTTP communication uses **axios** with a shared per-plugin instance. The instance is created in the plugin constructor with:
- `baseURL` injected from config (never hardcoded)
- `timeout: 10_000` — always set; triggers `GatewayTimeoutError` on expiry
- Auth headers set once at instance level

### Webhook Signature Verification

Always performed as the first operation in `parseWebhookEvent()`. Uses `crypto.timingSafeEqual` — not string equality — to prevent timing attacks. Throws `GatewayInvalidSignatureError` immediately on failure.

### Status Mapping Policy

- **Mapper `toUnifiedStatus()`** — throws `GatewayMappingError` on unknown status string. No fallback. A wrong status in Redis is worse than a loud failure.
- **Plugin `mapWebhookEventToStatus()`** — uses event string as authoritative source (not entity status field). Unknown events return `PROCESSING` (non-terminal, safe for re-polling).

---

## 10. Adding a New Gateway

checkoutOs follows a registry-driven plugin architecture. Adding a new gateway does not require changes to core business logic, services, or controllers.

### Steps

1. Create `src/gateways/<gateway>/<gateway>.types.ts`
2. Create `src/gateways/<gateway>/<gateway>.mapper.ts`
3. Create `src/gateways/<gateway>/<gateway>.plugin.ts`
4. Register in `gateway.registry.ts` — add to `supportedGateways`, `gatewayEnvDefinitions`, `gatewayCredentialEnvKeys`, and the `registerGateways()` switch
5. Add env vars to `env.schema.ts` and `.env.example`
6. Create mock server handlers

See `docs/GatewayIntegrationGuide.md` for the full implementation guide.

### Key Principle

Gateways are discovered via the registry, not hardcoded conditionals. This keeps the system extensible and aligned with the Open/Closed Principle.

---

## 11. Error Handling Hierarchy

| Layer | Responsibility |
|---|---|
| Gateway | Throw typed errors |
| Service | Enrich errors with domain context |
| Controller | Map errors to HTTP codes |
| Middleware | Format standardized response |

### Typed Errors

| Class | HTTP Status | When Thrown |
|---|---|---|
| `PaymentFailedError` | 402 | Gateway reports terminal failure |
| `PaymentNotFoundError` | 404 | `chk_` ID not in Redis |
| `InvalidAmountError` | 400 | Amount is zero, negative, or non-integer |
| `RefundNotAllowedError` | 422 | Refund attempted on non-SUCCESS payment |
| `GatewayTimeoutError` | 504 | Axios request exceeds 10 second timeout |
| `GatewayUnavailableError` | 503 | Gateway unreachable or returns unexpected HTTP error |
| `GatewayInvalidSignatureError` | 401 | Webhook HMAC verification fails |
| `GatewayMappingError` | 502 | Unknown status string in mapper |
| `StoreError` | 500 | Redis operation fails |

---

## 12. Startup Configuration Validation

checkoutOs fails fast on misconfiguration. On startup:

1. `EnvSchema.safeParse(process.env)` runs — process exits with a clear error list if any variable is missing or invalid
2. `registerGateways(env, activeGateway)` is called — instantiates the active plugin
3. Redis connectivity is verified
4. Gateway `healthCheck()` is called
5. `WEBHOOK_RELAY_URL` is validated

`getActiveGateway()` throws `GatewayUnavailableError` if called before `registerGateways()` completes — the error surfaces on the first request rather than silently.

---

## 13. API Endpoints

| Method | Path |
|---|---|
| `POST` | `/payments` |
| `GET` | `/payments/{chk_id}` |
| `POST` | `/payments/{chk_id}/refund` |
| `GET` | `/refunds/{ref_id}` |
| `POST` | `/webhooks/{gateway}` |
| `GET` | `/health` |
| `GET` | `/docs` |

---

## 14. Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express.js |
| HTTP Client | axios (gateway communication) |
| ID Generation | UUID v4 |
| Store | Redis |
| Redis Client | ioredis |
| Containers | Docker + Compose |
| Documentation | OpenAPI + Swagger |
| Config Validation | Zod |
| Logging | Winston |
| Mock Server | MSW (`@mswjs/http-middleware`) |

---

## 15. V1.0 Limitations (By Design)

All limitations are intentional and enable a simpler, cleaner V1.2.

| Limitation | Reason |
|---|---|
| No webhook retry | Deferred to V1.2 — keeps webhook handler stateless |
| No authentication | Deferred to V1.2 — reduces V1.0 scope |
| No auto-failover | Deferred to V1.2 — single active gateway keeps state simple |
| `gatewayPaymentId` empty at creation | By design — only available after webhook confirms capture |