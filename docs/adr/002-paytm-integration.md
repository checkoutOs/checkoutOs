# ADR 002 — Paytm Gateway Integration

**Status:** Accepted  
**Date:** 2026-04-23  
**Deciders:** checkoutOs core team  

---

## Context

checkoutOs V1.1 supports Razorpay as its first gateway. The architecture was designed as a plugin system where new gateways can be added by implementing the `GatewayPlugin` interface and registering in `gateway.registry.ts`, with zero changes to services or controllers.

Paytm is the second supported gateway. It differs from Razorpay across several dimensions that must be fully contained inside the plugin.

---

## Decisions

### 1. Plugin Architecture — Zero Core Changes

Paytm is integrated using the existing plugin contract (`GatewayPlugin`). No changes to controllers, services, or routes were made specifically for Paytm. Every Paytm-specific behaviour is isolated inside `src/gateways/paytm/`.

**Consequence:** Adding a third gateway follows the same pattern: implement `GatewayPlugin` + register.

---

### 2. Checkout Flow — `getCheckoutAction()` Abstraction

Razorpay renders an embedded SDK modal; Paytm redirects to an external payment page via HTTP 302. These are fundamentally different controller behaviours.

**Decision:** Add `getCheckoutAction(payment: StoredPayment): CheckoutAction` to the `GatewayPlugin` interface. The checkout controller calls this method and dispatches on `action.type`:

```
type: 'render'   → res.send(renderCheckoutPage())   ← Razorpay
type: 'redirect' → res.redirect(302, action.url)    ← Paytm
```

No gateway-specific `if/else` appears in the controller. The controller is entirely gateway-agnostic.

**Alternative considered:** Two separate route handlers (`/checkout/razorpay/:chkId`, `/checkout/paytm/:chkId`). Rejected — violates the unified interface contract and leaks gateway names into the HTTP API.

---

### 3. Webhook Body Format — Per-Gateway Middleware

Razorpay sends `application/json` (raw Buffer required for HMAC). Paytm sends `application/x-www-form-urlencoded` (NVP parsed object required for CHECKSUMHASH).

**Decision:** Mount body parsers in `app.ts` scoped per gateway route, before `express.json()`:

```
express.raw({ type: 'application/json' })  → /webhooks/razorpay
express.urlencoded({ extended: true })      → /webhooks/paytm
express.json()                              → all other routes
```

This is load-order sensitive. The parsers must appear before `express.json()` to prevent body stream consumption.

**Alternative considered:** Route-level middleware inside the webhook router. Rejected — sharing the webhook router between gateways means the router must know which middleware to apply per gateway, leaking gateway-specific logic outside the plugin.

---

### 4. Webhook Signature Algorithm — External Library

Razorpay uses HMAC-SHA256 (standard, implementable inline). Paytm uses SHA256 + AES-128-CBC (non-standard, requires Paytm's own library).

**Decision:** Use the `paytmchecksum` npm package (v1.5.1) with a custom `.d.ts` declaration file, since the package ships no TypeScript types. `PaytmChecksum.verifySignature(body, key, checksum)` accepts the already-parsed NVP object.

**Alternative considered:** Copy `PaytmChecksum.js` source into the repo. Rejected — adds maintenance burden and diverges from the upstream library.

---

### 5. Payment ID Strategy — Option C (Two IDs)

Paytm assigns ORDERID at payment creation time and TXNID only after the transaction completes. This matches Razorpay's `order_XXXX` / `pay_XXXX` split.

**Decision:** Use Option C unchanged:
- `gatewayOrderId` ← Paytm `ORDERID` (set at creation, used for polling and as the initial reverse lookup key)
- `gatewayPaymentId` ← Paytm `TXNID` (set when the first webhook arrives, used for refunds)

**Webhook lookup fix:** The webhook service's fallback previously only understood Razorpay's raw JSON format. Added `gatewayOrderId?: string` to `WebhookEvent` so plugins can surface their order ID for the service's fallback lookup without gateway-specific code in the service.

---

### 6. Payment URL Storage in Redis

Paytm's `initiateTransaction` response includes a `paymentUrl` for the customer's payment page. `getCheckoutAction()` must return this URL.

**Decision:** Store `paymentUrl` in `StoredPayment` at creation time (populated from `GatewayPaymentResult.paymentUrl`). `getCheckoutAction()` reads `payment.paymentUrl` directly — no network call on every checkout page load.

**Fallback:** If `paymentUrl` is absent (legacy records or Razorpay), reconstruct from `baseURL + showPaymentPage` path + `gatewayOrderId`.

---

### 7. State Machine Guard

Paytm may send `TXN_SUCCESS` then later reversal notifications for the same `TXNID`. Without protection, the payment status could flip SUCCESS → FAILED.

**Decision:** Implement `VALID_TRANSITIONS` in `webhook.service.ts`. All terminal states (`SUCCESS`, `FAILED`, `CANCELLED`, `EXPIRED`, `REFUNDED`, `PARTIALLY_REFUNDED`) have empty allowed-transitions arrays. Invalid transitions are logged as warnings and silently ignored (never throw — a non-200 response triggers gateway retry storms).

---

### 8. Website Name Configuration

Paytm's `initiateTransaction` API requires a `websiteName` field that identifies the checkout environment. `'WEBSTAGING'` is required for sandbox; `'DEFAULT'` or a custom name is required for production.

**Decision:** Expose `PAYTM_WEBSITE_NAME` as an environment variable. The plugin defaults to `'WEBSTAGING'` when the variable is absent. This prevents the hardcoded sandbox value from silently breaking production payments.

---

### 9. Health Check Strategy

Paytm has no lightweight ping endpoint. `GET /orders?count=1` (Razorpay pattern) does not exist.

**Decision:** Call `transactionStatus` with a deliberately invalid `ORDERID` (`'HEALTH_CHECK_DUMMY_ORDER'`). Any structured HTTP response (including 4xx) proves the API is reachable and authenticating correctly. Only network errors, timeouts, or connection failures return `healthy: false`.

---

### 10. Refund Status Polling

Paytm does not support polling refund status via API. Refund updates arrive only through webhooks.

**Decision:** `getRefundStatus()` always throws `GatewayUnavailableError` with an explanatory message. This is the correct contract — callers should not poll; they must wait for the webhook.

---

## Consequences

### Positive

- Paytm fully integrated with zero changes to `payments.service`, `refunds.service`, `webhook.service` contracts, or any controller.
- Plugin boundary enforces that Paytm-specific state (checksum algo, NVP format, TXNID vs ORDERID) never leaks to the service layer.
- The `getCheckoutAction()` abstraction is now available to all future gateways (Cashfree UPI, PayU redirect, etc.) with no further controller changes.
- State machine guard protects all gateways (not just Paytm) from invalid status reversals.

### Negative / Trade-offs

- `paytmchecksum` is a third-party npm package with no TypeScript support and an unconventional crypto approach. If Paytm deprecates it, the plugin must be updated.
- `websiteName: 'WEBSTAGING'` is a foot-gun if `PAYTM_WEBSITE_NAME` is not set in production. A startup-time warning log when `NODE_ENV=production` and the var is absent would be a useful hardening step.
- The `paymentUrl` fallback reconstruction (using `showPaymentPage` path + `gatewayOrderId`) is not guaranteed to produce a valid URL if Paytm changes their payment page URL scheme.

---

## Status of Related Work

| Item | Status |
|---|---|
| Core plugin (`paytm.plugin.ts`) | Complete |
| Status mapper (`paytm.mapper.ts`) | Complete |
| Registry wiring | Complete |
| `getCheckoutAction()` abstraction | Complete |
| State machine guard | Complete |
| Paytm ORDERID webhook fallback | Complete |
| `paymentUrl` Redis storage | Complete |
| `PAYTM_WEBSITE_NAME` config | Complete |
| Unit tests (mapper, plugin, webhook service) | Complete |
| Integration tests (webhook API, checkout) | Complete |
| Paytm mock server | Complete |
| OpenAPI spec update | Complete |
| Production `websiteName` validation at startup | Pending (V1.2) |
| Mock server paytmchecksum signing for e2e tests | Pending (V1.2) |
