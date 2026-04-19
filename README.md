# checkoutOs

A redirect-based, SDK-less HTTP API that wraps Indian payment gateways behind a single unified contract.

Switch between Razorpay, PayU, and Cashfree by changing one environment variable.

---

## What It Does

Every payment gateway in India ships its own SDK, uses different status strings, and has unique integration quirks. checkoutOs solves this by exposing a single stable API:

```
POST /payments          → create a payment, get a paymentUrl to redirect the user
GET  /payments/:chkId   → check payment status
POST /payments/:chkId/refund → refund a payment
GET  /refunds/:refId    → check refund status
POST /webhooks/:gateway → receive gateway webhooks (configure in dashboard)
GET  /health            → service health check
```

All amounts are in **paise** (₹500 = `50000`).

---

## Quick Start

### Prerequisites

- Node.js v20 (or v18+)
- Docker (for Redis)
- npm

### 1. Clone and install

```bash
git clone https://github.com/your-org/checkoutos.git
cd checkoutos
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials. For local development with the mock server, use these values:

```bash
NODE_ENV=development
PORT=3000
ACTIVE_GATEWAY=razorpay
REDIS_URL=redis://localhost:6379
WEBHOOK_RELAY_URL=http://localhost:4000/webhook
RAZORPAY_BASE_URL=http://localhost:9090
RAZORPAY_KEY_ID=rzp_test_mockKeyId00001
RAZORPAY_KEY_SECRET=mockSecret00001
RAZORPAY_WEBHOOK_SECRET=mockWebhookSecret001
```

### 3. Start Redis

```bash
docker run -d --name checkoutos-redis -p 6379:6379 redis:7-alpine
```

### 4. Start the mock gateway server

```bash
npm run mock:gateway
# ✓ Listening on http://localhost:9090
```

### 5. Start the app

```bash
npm run dev
# [server] checkoutOs server started { port: 3000, gateway: 'razorpay' }
```

### 6. Test it

```bash
# Health check
curl -s http://localhost:3000/health | jq

# Create a payment
curl -s -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -d '{"amount":50000,"currency":"INR","orderId":"order_001"}' | jq
```

---

## Running with Docker Compose

Runs the full stack: checkoutOs + Redis + mock gateway server.

```bash
# Copy and configure environment
cp .env.example .env

# Start app + Redis only
docker compose up

# Start app + Redis + mock gateway server
docker compose --profile mock up

# Run in background
docker compose up -d

# View logs
docker compose logs -f

# Stop everything
docker compose down
```

**Note:** `docker-compose.yml` overrides `REDIS_URL` to `redis://redis:6379` so the app connects to the Redis container by its service name. You do not need to change `REDIS_URL` in `.env` for Docker Compose.

---

## API Reference

Full OpenAPI specification is at `docs/openapi.yaml`.

When the server is running, Swagger UI is available at:
```
http://localhost:3000/docs
```

### Quick reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/payments` | Create a payment |
| `GET` | `/payments/:chkId` | Get payment status |
| `POST` | `/payments/:chkId/refund` | Refund a payment |
| `GET` | `/refunds/:refId` | Get refund status |
| `POST` | `/webhooks/:gateway` | Receive gateway webhook |
| `GET` | `/health` | Service health |

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | — | `development` / `production` / `test` |
| `PORT` | No | `3000` | HTTP server port |
| `ACTIVE_GATEWAY` | Yes | — | `razorpay` / `payu` / `cashfree` |
| `REDIS_URL` | Yes | — | Redis connection string |
| `WEBHOOK_RELAY_URL` | Yes | — | URL to relay normalized webhooks |
| `RAZORPAY_KEY_ID` | Conditional | — | Required when `ACTIVE_GATEWAY=razorpay` |
| `RAZORPAY_KEY_SECRET` | Conditional | — | Required when `ACTIVE_GATEWAY=razorpay` |
| `RAZORPAY_WEBHOOK_SECRET` | Conditional | — | Required when `ACTIVE_GATEWAY=razorpay` |
| `RAZORPAY_BASE_URL` | No | Razorpay prod URL | Override for mock server |

See `.env.example` for the full list including PayU and Cashfree variables.

---

## Testing

```bash
# Install test dependencies (first time only)
npm install --save-dev vitest @vitest/coverage-v8 supertest @types/supertest ioredis-mock

# Unit tests — no Redis needed
npm run test:unit

# Integration tests — Redis required
docker start checkoutos-redis
npm run test:integration

# All tests
npm test

# Watch mode (unit tests, fast feedback during development)
npm run test:watch

# Coverage report
npm run test:coverage
```

---

## Webhook Configuration

### Configure your gateway dashboard

Set your webhook URL in the Razorpay dashboard to:
```
https://your-checkoutos-host/webhooks/razorpay
```

### What checkoutOs does with webhooks

1. Verifies the HMAC-SHA256 signature
2. Updates the payment status in Redis
3. Sets the `gatewayPaymentId` (`pay_XXXX`) on the stored payment record
4. Relays the normalized event to your `WEBHOOK_RELAY_URL`

### What your relay endpoint receives

```json
{
  "paymentId": "chk_a1b2c3d4...",
  "gateway": "razorpay",
  "gatewayPaymentId": "pay_ABC123",
  "event": "payment.captured",
  "status": "SUCCESS",
  "amount": 50000,
  "currency": "INR",
  "raw": { }
}
```

Your application always receives a `chk_` prefixed `paymentId` — never gateway-native IDs.

---

## Payment Flow

```
1. Your server:   POST /payments  →  { paymentId, paymentUrl }
2. Your frontend: redirect user to paymentUrl
3. User:          completes payment on gateway page
4. Gateway:       fires webhook to /webhooks/razorpay
5. checkoutOs:    updates payment status in Redis, relays to WEBHOOK_RELAY_URL
6. Your server:   receives relay with { paymentId, status: "SUCCESS" }
```

---

## Production Deployment

### Build

```bash
npm run build
# Compiles TypeScript to dist/
```

### Docker

```bash
# Build production image
docker build -t checkoutos:latest .

# Run with environment variables
docker run -d \
  --name checkoutos \
  -p 3000:3000 \
  --env-file .env \
  -e REDIS_URL=redis://your-redis-host:6379 \
  checkoutos:latest
```

### Health check

The `/health` endpoint is your liveness probe:

```bash
curl http://localhost:3000/health
# {"success":true,"data":{"status":"ok","timestamp":"...","services":{...}}}
```

Returns `200` when healthy, `503` when degraded.

---

## Switching Gateways

Change one environment variable and restart:

```bash
# Switch from Razorpay to PayU
ACTIVE_GATEWAY=payu
PAYU_MERCHANT_KEY=your_merchant_key
PAYU_MERCHANT_SALT=your_merchant_salt
PAYU_WEBHOOK_SECRET=your_webhook_secret
```

No code changes required. All payment IDs (`chk_`) remain stable across gateway switches.

> **Note:** PayU and Cashfree plugins are pending (V1.x). See `docs/GatewayIntegrationGuide.md` to implement them.

---

## Project Documentation

| Document | Contents |
|---|---|
| `docs/Steps.md` | Build steps 1–6 (types through gateway layer) |
| `docs/Steps_7_to_11.md` | Build steps 7–11 (services through testing) |
| `docs/ContributorGuide.md` | Full contributor reference |
| `docs/V1_0ArchitectureDesign.md` | Architecture decisions and design spec |
| `docs/GatewayIntegrationGuide.md` | How to add new payment gateways |
| `docs/checkoutOs_handbook.md` | Complete project handbook (all-in-one) |
| `docs/openapi.yaml` | OpenAPI 3.0 specification |

---

## License

ISC