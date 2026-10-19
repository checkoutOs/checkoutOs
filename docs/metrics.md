# checkoutOs metrics reference

checkoutOs exposes Prometheus-format metrics on a **separate listener**, never on the API port:

```
GET http://<host>:9464/metrics          # METRICS_PORT, default 9464
Authorization: Bearer <METRICS_AUTH_TOKEN>   # only if METRICS_AUTH_TOKEN is set
```

Any Prometheus-compatible scraper works: Prometheus, Grafana Alloy, the Datadog Agent (`openmetrics` check), or the OpenTelemetry Collector (`prometheusreceiver`). `observability/prometheus/prometheus.yml` is a working example. The design is in [ADR 003](adr/003-observabilityPlan.md).

**This page is the contract.** Metric names, label keys, label values and bucket boundaries are a public API. See the [stability policy](#stability-policy).

---

## Naming

- Every metric is prefixed `checkoutos_`.
- **Counters** end in `_total`.
- **Durations are in seconds** (base units only), but **names carry no unit suffix.** The exporter in use (`@opentelemetry/exporter-prometheus` 0.223) writes the unit only as a `# UNIT` metadata line. So the series is `checkoutos_gateway_request_duration`, not `..._seconds`. This is the same convention as the HTTP histogram below, which checkoutOs does not name itself.
- **Money is in minor currency units** (paise for INR), always with a `currency` label.
- Histograms expose `_bucket{le=…}`, `_sum` and `_count`.

Every series also carries `otel_scope_name="checkoutos"`. The HTTP metrics instead carry `otel_scope_name="@opentelemetry/instrumentation-http"` and `otel_scope_version`. Resource attributes (`service_name`, `service_version`, `deployment_environment_name`) are **not** labels on each series. They live on `target_info`, so join on it:

```promql
sum by (gateway) (rate(checkoutos_payments_created_total[5m]))
  * on (job, instance) group_left (deployment_environment_name) target_info
```

---

## Gateway calls

Recorded for every gateway by a wrapper applied in the registry, so plugins never record metrics themselves. A new gateway is instrumented the day it is registered.

| Metric | Type | Labels |
|---|---|---|
| `checkoutos_gateway_request_duration` | histogram, seconds | `gateway`, `operation`, `outcome` |
| `checkoutos_gateway_requests_total` | counter | `gateway`, `operation`, `outcome` |
| `checkoutos_webhook_signature_failures_total` | counter | `gateway` |

- **`gateway_request_duration`** times each call to the gateway API.
- **`gateway_requests_total`** counts those calls.
- **`webhook_signature_failures_total`** counts inbound webhooks rejected for a bad signature or checksum. A sustained non-zero rate is a possible forgery attempt.

Buckets for `gateway_request_duration`: `0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 8, 10, 15`. The gateway timeout is 10 s; the 8 s boundary exists so a "p99 above 80% of the timeout" alert is exact.

## Payments

| Metric | Type | Labels |
|---|---|---|
| `checkoutos_payments_created_total` | counter | `gateway`, `currency`, `status` |
| `checkoutos_payment_transitions_total` | counter | `gateway`, `from`, `to`, `source` |
| `checkoutos_payment_transitions_blocked_total` | counter | `gateway`, `from`, `to`, `source` |
| `checkoutos_gateway_poll_success_suppressed_total` | counter | `gateway` |

- **`payments_created_total`** counts payments created at the gateway and persisted. A request deduplicated by `orderId` is not counted here.
- **`payment_transitions_total`** counts status changes. `source` says who made the change: `webhook`, `poll` or `refund`.
- **`payment_transitions_blocked_total`** counts webhook status changes the state machine refused. `source` is always `webhook`. A steady stream of one `from`→`to` pair usually means a gateway event is mapped to the wrong status.
- **`gateway_poll_success_suppressed_total`** counts status polls that saw SUCCESS but were held back, because SUCCESS is webhook-only. A sustained rate means webhooks are not arriving: money is captured but unrefundable. Alert: `rate(checkoutos_gateway_poll_success_suppressed_total[30m]) > 0`.

## Webhooks

| Metric | Type | Labels |
|---|---|---|
| `checkoutos_webhook_received_total` | counter | `gateway`, `event`, `result` |
| `checkoutos_webhook_unknown_payment_total` | counter | `gateway` |
| `checkoutos_webhook_processing_duration` | histogram, seconds | `gateway` |
| `checkoutos_webhook_relay_attempts_total` | counter | `outcome` |
| `checkoutos_webhook_relay_duration` | histogram, seconds | — |

- **`webhook_received_total`** counts every inbound delivery, labelled with what checkoutOs did with it.
- **`webhook_unknown_payment_total`** counts deliveries whose gateway IDs match no payment: orphans or lookup bugs.
- **`webhook_processing_duration`** times signature check, lookup and state machine, and **excludes the relay**.
- **`webhook_relay_attempts_total`** counts relays to `WEBHOOK_RELAY_URL`. The relay is fire-and-forget, so this is the only signal that merchants are not receiving events.
- **`webhook_relay_duration`** times the relay call.

The relay is awaited before checkoutOs answers the gateway. A slow merchant endpoint therefore delays the gateway's response, but it shows up in `webhook_relay_duration`, never in `webhook_processing_duration`.

Buckets:

- `webhook_processing_duration`: `0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5`
- `webhook_relay_duration`: `0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 7.5` (the relay timeout is 5 s)

## Idempotency and orderId dedup

| Metric | Type | Labels |
|---|---|---|
| `checkoutos_idempotency_decisions_total` | counter | `result` |
| `checkoutos_orderid_reservation_conflicts_total` | counter | `result` |

- **`idempotency_decisions_total`** counts one `Idempotency-Key` decision per `POST /payments`. A rising `hit` rate means clients are retrying, so something upstream is failing.
- **`orderid_reservation_conflicts_total`** counts `POST /payments` whose `orderId` was already taken, by how it was resolved.

## Refunds

| Metric | Type | Labels |
|---|---|---|
| `checkoutos_refunds_total` | counter | `gateway`, `outcome` |
| `checkoutos_refund_amount_minor_total` | counter | `gateway`, `currency` |

- **`refunds_total`** counts refund requests.
- **`refund_amount_minor_total`** is the amount successfully refunded, in minor units.

## HTTP (from OpenTelemetry instrumentation)

These are emitted by `@opentelemetry/instrumentation-http` with stable semantic conventions. checkoutOs does not name them and never defines a second HTTP duration histogram.

| Metric | Type | Labels (main) |
|---|---|---|
| `checkoutos_http_server_request_duration` | histogram, seconds | `http_request_method`, `http_route`, `http_response_status_code`, `url_scheme`, `network_protocol_version`, `error_type` (5xx only) |
| `checkoutos_http_client_request_duration` | histogram, seconds | `http_request_method`, `server_address`, `server_port`, `http_response_status_code`, `error_type` (failures only) |

- **`http_server_request_duration`** times inbound API requests. `http_route` is the route pattern (`/payments/:chkId`), never the raw path.
- **`http_client_request_duration`** times outbound calls to gateways and the webhook relay.

Server buckets: `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`. The client histogram uses the instrumentation's defaults.

## Process

| Metric | Type | Labels |
|---|---|---|
| `checkoutos_build_info` | gauge, always 1 | `version` |
| `target_info` | gauge, always 1 | resource attributes |

- **`build_info`** proves the metric pipeline is wired; startup fails without it.
- **`target_info`** carries the resource attributes: `service_name`, `service_version`, `deployment_environment_name`, plus host/process attributes.

---

## Label values

Every label takes values from a **closed set**. Anything outside the set is reported as the fallback shown, never as a new value. That is how a payment ID or a raw URL can never become a label.

| Label | Values | Fallback |
|---|---|---|
| `gateway` | `razorpay`, `paytm`, `payu`, `cashfree` | `unknown` |
| `operation` | `createPayment`, `getPaymentStatus`, `createRefund`, `getRefundStatus`, `healthCheck` | `unknown` |
| `outcome` (gateway) | `success`, `timeout`, `gateway_error`, `mapping_error` | `unknown` |
| `status`, `from`, `to` | `PENDING`, `PROCESSING`, `SUCCESS`, `FAILED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `CANCELLED`, `EXPIRED` | `unknown` |
| `currency` | `INR` | `unknown` |
| `source` | `webhook`, `poll`, `refund` | `unknown` |
| `event` | `payment.authorized`, `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed` (Razorpay); `TXN_SUCCESS`, `TXN_FAILURE`, `PENDING` (Paytm) | `other` |
| `result` (webhook) | `updated`, `unchanged`, `blocked`, `unknown_payment`, `record_missing`, `rejected`, `error` | `unknown` |
| `outcome` (relay) | `success`, `http_error`, `timeout`, `network_error` | `unknown` |
| `result` (idempotency) | `miss`, `hit`, `in_progress`, `stale_recovered`, `hash_mismatch` | `unknown` |
| `result` (orderId) | `deduplicated`, `in_progress`, `amount_mismatch`, `currency_mismatch` | `unknown` |
| `outcome` (refund) | `created`, `rejected`, `gateway_error` | `unknown` |

What the less obvious values mean:

- **`result` (webhook):**
  - `updated`: the status changed and/or the gateway payment ID was recorded.
  - `unchanged`: a duplicate or same-status delivery.
  - `blocked`: the state machine refused the change; see `payment_transitions_blocked_total`.
  - `rejected`: the signature or body was invalid, so `event` is `other`.
  - `error`: failed after parsing, for example Redis unavailable.
- **`outcome` (relay):**
  - `http_error`: the merchant answered non-2xx.
  - `timeout`: no answer within 5 s.
  - `network_error`: DNS failure, connection refused or reset.
- **`result` (idempotency):** `stale_recovered` means an abandoned in-progress claim (over 30 s old) was taken over.
- **`outcome` (refund):** `rejected` means refused before the gateway call (not refundable, amount too large); `gateway_error` means the gateway call failed.

**Never** labels: `chkId`, `orderId`, `refId`, gateway payment/order IDs, customer data, raw paths. They are in the logs, where they are searchable without creating a time series per payment.

---

## Stability policy

| Change | Allowed in |
|---|---|
| Adding a new metric | Any release |
| Adding a new **value** to an existing label's closed set | Minor |
| Adding a new **label** to an existing metric | **Major**: it changes series identity and breaks existing aggregations |
| Renaming a metric | **Major**, and only with a deprecation cycle |
| Removing a metric | **Major**, after one minor release marked deprecated |
| Changing bucket boundaries | **Major**: it silently shifts every quantile |
| Changing a unit | **Major**; never do this |

**Deprecation cycle:**

1. Emit both the old and the new name for one full minor version.
2. Mark the old one *deprecated* on this page and in the changelog.
3. Remove it in the next major release.

**Enforcement:** CI (`npm run verify:telemetry -- --check`) compares the live `/metrics` exposition against `observability/exposition.snapshot.txt`. That file records metric names, label **keys** and bucket boundaries, never values. Any change fails CI until the snapshot is regenerated and committed, so every contract change is visible in review. `checkoutos_gateway_poll_success_suppressed_total` is the one metric the verification run does not exercise; unit tests cover it.

> Upgrading `@opentelemetry/exporter-prometheus` may start appending unit suffixes (`_seconds`) to names. The snapshot catches that. Treat it as a rename under the policy above.

## Deprecated

None.
