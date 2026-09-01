# ADR 001 — Idempotency for Payment Creation

**Status:** Accepted  
**Date:** 2026-04-14  
**Deciders:** checkoutOs core team

---

## Context

`POST /payments` creates a payment on the active gateway. Duplicate submissions are a production inevitability, not an edge case:

- Network retries from flaky mobile connections
- Double-clicks on the pay button
- Browser refresh after submitting
- Mobile app re-submission after timeout

Without idempotency each retry creates a second gateway order and a second `chk_` payment for the same merchant order — duplicate charges.

Two independent dedup dimensions exist:

1. **Same client retry** — identical payload resent with the same `Idempotency-Key` header.
2. **Different key, same business order** — a client regenerates the key but reuses the same `orderId` (e.g. after a crash between gateway call and response).

---

## Decision

Adopt **Option A — Pure Service Layer**, respecting handbook layer boundaries:

1. **Middleware** (`src/middleware/idempotency.middleware.ts`) extracts the `Idempotency-Key` header, validates UUID format, computes a SHA-256 request hash (`method:path:body`) via `src/utils/hash.ts`, and attaches `{ key, requestHash }` to `req.idempotency`. It performs **no** service calls and **no** Redis access (§4.2).
2. **IdempotencyService** (`src/services/idempotency.service.ts`) owns all dedup business logic: `checkIdempotency()` returns `MISS` / `HIT` / `IN_PROGRESS`; `completeIdempotency()` marks records COMPLETED after successful creation.
3. **PaymentService.createPaymentWithIdempotency()** orchestrates: check → orderId dedup → gateway create → complete. A `complete()` failure never breaks the payment response.
4. **IdempotencyStore** is the only layer touching Redis: key `chk:idem:{key}`, TTL 86400 s, atomic `SET NX EX` for creation.
5. The controller stays HTTP-only; it forwards `req.idempotency` verbatim.

### Production fixes applied (beyond the base design)

| Issue | Fix |
|---|---|
| Stale IN_PROGRESS deadlock | 30 s staleness check; recovery via **atomic Lua `forceUpdateIfInProgress`** which overwrites only if status is still IN_PROGRESS — replaces the plan's delete+setNx sequence, which had a crash window where a concurrent recovery could observe "no record" and both proceed |
| `complete()` failure | try/catch inside the service; boolean return, structured error log; DLQ deferred to V1.2 |
| orderId mismatch | amount AND currency validated on orderId collision → 409 `ORDER_ID_AMOUNT_MISMATCH` / `ORDER_ID_CURRENCY_MISMATCH`, backed by a `chk:pay:by-order:{orderId}` reverse index written in the same Redis pipeline as the payment |
| Race condition | iterative re-fetch bounded by `IDEMPOTENCY_MAX_RETRIES` (3); exhaustion degrades to IN_PROGRESS (409), never an error |
| Update atomicity | Lua script for updates: applies only when the key exists, preventing orphan COMPLETED records |
| Observability | structured logs at every decision point (`idempotency.miss`, `.hit`, `.stale_in_progress`, `.hash_mismatch`, …) |

### Hash-scope note

The hash includes `(method, path)` so one key cannot silently collide across endpoints. Because the router is mounted at `/payments`, the middleware hashes path `'/'` — clients never see this; it is internal detail relevant only to tests reproducing hashes.

---

## Consequences

### Positive

- Layer boundaries preserved exactly; no middleware→Redis or controller→store shortcuts
- Each layer independently testable: store against ioredis-mock, service with spies, end-to-end through real HTTP + Redis + MSW mock gateway
- Crash recovery works twice over: stale-window auto-recovery (30 s) plus permanent fallback via orderId dedup
- Cached HIT replays are byte-identical responses — safe for client retry logic

### Negative

- One extra Redis round-trip per creation (GET + SET NX)
- 409 latency includes controller + service hop before rejection (acceptable: conflicts are rare and client-triggered)
- Clients must generate and persist UUID keys — documented in OpenAPI

---

## Alternatives Considered

### Option B — Middleware calls the service directly

Rejected: violates §5.5 (middleware would need Redis) and §5.7 (services own business logic). Also sets precedent for auth/rate-limit middleware reaching into storage.

### Gateway-native idempotency keys (Razorpay `idempotency` header)

Rejected as primary mechanism: Paytm offers no equivalent, so it would leak gateway differences into the service layer. checkoutOs must stay gateway-uniform.

### No idempotency

Rejected: duplicate charges are unacceptable for a payments orchestrator.

---

## Deferred to V1.2

- Merchant namespace on Redis keys: `chk:idem:{merchantId}:{key}`
- Idempotency metrics (hit rate, stale recoveries, conflict counts)
- Dead-letter queue for `complete()` failures
- Refund endpoint idempotency

---

## Related

- Handbook §4.2 — layer architecture · §5.3 utils · §5.5 store · §5.7 services
- `idempotency.md` — full implementation plan this ADR summarises
- Tests: `tests/unit/store/idempotency.store.test.ts`, `tests/unit/services/idempotency.service*.test.ts`, `tests/integration/idempotency.test.ts`
