# checkoutOs Mock Gateway Server

A standalone HTTP mock server for payment gateway APIs.
Built with [MSW](https://mswjs.io/) + [`@mswjs/http-middleware`](https://github.com/mswjs/http-middleware).

---

## Start the server

```bash
npm run mock:gateway
```

The server starts on `http://localhost:9090` by default.

To use a different port:

```bash
MOCK_PORT=8080 npm run mock:gateway
```

---

## Directory Structure

```
mocks/
  server.ts                          ← Entry point — starts the HTTP server
  gateways/
    razorpay/
      auth.ts                        ← Basic Auth validation
      errors.ts                      ← Typed Razorpay error response builders
      handlers.ts                    ← Collects all Razorpay handlers
      orders/
        create.handler.ts            ← POST /v1/orders
```

---

## Test Credentials

| Variable               | Value                   |
|------------------------|-------------------------|
| `RAZORPAY_KEY_ID`      | `rzp_test_mockKeyId00001` |
| `RAZORPAY_KEY_SECRET`  | `mockSecret00001`       |

---

## Mocked Endpoints

### Razorpay

| Method | Endpoint                              | Status |
|--------|---------------------------------------|--------|
| POST   | `https://api.razorpay.com/v1/orders`  | ✓ Live |

---

## Authentication Behavior

The mock validates Basic Auth exactly as Razorpay does.

| Scenario                  | Response |
|---------------------------|----------|
| No `Authorization` header | `401` — missing header |
| Wrong credentials         | `401` — invalid credentials |
| Correct credentials       | Proceeds to validation |

---

## Validation Behavior

| Scenario                    | Response |
|-----------------------------|----------|
| Missing `amount`            | `400` — field required |
| `amount` < 100              | `400` — invalid amount |
| `amount` not an integer     | `400` — invalid amount |
| Missing `currency`          | `400` — field required |
| Unsupported `currency`      | `400` — invalid currency |
| All valid                   | `200` — order created |

---

## Predictability Contract

- **No randomness.** Order IDs are derived deterministically from `receipt`.
- **Fixed timestamps.** `created_at` is always `1705314600` (2024-01-15T10:30:00Z).
- **Stable test credentials.** Credentials never change without a version bump.

This ensures tests never fail due to non-deterministic mock behavior.

---

## Adding a New Gateway

1. Create `mocks/gateways/<gateway>/` folder
2. Add `auth.ts`, `errors.ts`, `handlers.ts`
3. Add endpoint handlers under `mocks/gateways/<gateway>/<resource>/`
4. Import and spread handlers in `mocks/server.ts`

No other changes needed.

---

## Adding a New Razorpay Endpoint

1. Create the handler file:
   ```
   mocks/gateways/razorpay/<resource>/<action>.handler.ts
   ```
2. Export a named handler from it
3. Import and add it to `mocks/gateways/razorpay/handlers.ts`

---

## package.json Script

```json
"scripts": {
  "mock:gateway": "tsx mocks/server.ts"
}
```