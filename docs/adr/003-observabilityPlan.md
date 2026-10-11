# ADR 003 — Observability Plan: Metrics, Logs & Traces

**Status:** Proposed
**Date:** 2026-09-01
**Revised:** 2026-09-15 — verified and corrected against the tree at `a7f18a3` across two review rounds; see §14. **Phase 0 is now blocked on a prerequisite — see §5 Phase 0 Prerequisites.**
**Owners:** checkoutOs core team
**Scope:** OpenTelemetry instrumentation, Prometheus-format pull metrics, Grafana Loki logs, optional Tempo traces

---

## 1. Why now

checkoutOs moves money and currently has **no production visibility**. Every signal today is an unstructured log line on stdout. Several known failure modes are, by construction, invisible:

| Failure mode | Today | Source |
|---|---|---|
| Webhook relay to a merchant fails | Warning log, request still returns 200 — silent data loss | `webhook.service.ts:246` |
| Refund webhooks blocked by the state machine | Warning log, no aggregate signal | `webhook.service.ts:180` |
| Payment polled SUCCESS but `gatewayPaymentId` empty | Warning log — the money is unrefundable and nobody is counting | `payments.service.ts:320` |
| Forged / invalid webhook signatures | 401 returned, no counter — an attack looks like noise | `razorpay.plugin.ts`, `paytm.plugin.ts` |
| Webhook for an unknown payment | Warning log, returns silently | `webhook.service.ts:143` |

Two of these correspond to open correctness bugs. Both would announce themselves within an hour of the counters in §6 existing.

Instrumenting before the next feature means the next bug reports itself.

> **Caveat.** Observability does not fix the outstanding security gaps (unauthenticated API, unauthenticated refund endpoint). It will show unauthorised refunds happening; it will not stop them. Authentication should follow immediately after Phase 2.

---

## 2. Guiding principle — open-core

> **Instrumentation lives in core. Backends live in config.**

Three rules follow, and every decision below is downstream of them.

### 2.1 The OSS edition emits everything

No signal is withheld for a paid tier. If enterprise users receive better instrumentation, the community stops contributing to the telemetry code and it decays into a second-class path. The emission layer is identical in every edition.

### 2.2 Enterprise sells destinations, not emission

What a commercial tier can legitimately add:

- managed Grafana Cloud / Datadog / New Relic pipelines
- long-term retention and warehousing
- SLO reporting, anomaly detection, per-merchant analytics

All reachable by changing configuration. **Zero code difference between editions.**

### 2.3 Nothing leaves the box by default

For open-source payment infrastructure, a telemetry phone-home would be a trust catastrophe. No exporter configured means no egress. This must be stated explicitly in the README, not merely implied.

The pull-based metrics decision in §3.2 satisfies this *mechanically* rather than by policy — see §3.2.2.

### 2.4 Why OpenTelemetry specifically

OTel is the only standard where instrumentation and backend are genuinely decoupled, which is precisely what §2.2 requires. Practical consequence for contributors:

- **Never** `import` a vendor SDK anywhere in `src/`
- **Never** reference Prometheus, Loki, or Grafana types in business code
- The only vendor-aware code is the exporter wiring in `src/telemetry/`

#### Do not build a second abstraction on top of it

A recurring design instinct is to add a "provider-agnostic instrumentation layer" that selects an export strategy per deployment target. **That layer is the OTel SDK.** Providing it is the SDK's entire reason for existing, and duplicating it produces:

- more code paths than there are deployments — three branches serving one real target
- untestable branches, since a path for a runtime the application cannot execute in cannot be exercised in CI
- an abstraction shaped by guesswork, which the first real deployment on that target will invalidate

The correct structure is the one this plan already specifies: business code emits through the OTel API and names no destination; `src/telemetry/tracing.ts` is the **only** file that references an exporter. Supporting a new target later means adding a reader in that single file (§3.4) — not a new layer.

---

## 3. Signal architecture and transport decisions

```
              ┌──────────────────────────────────────────────┐
              │                  checkoutOs                  │
              │                                              │
              │   ┌──────────────────────────────────────┐   │
              │   │               OTel SDK               │   │
              │   │  Instruments  ·  Context  ·  Resource│   │
              │   └───┬───────────────┬──────────────┬───┘   │
              │       │               │              │       │
              │       │           decorates          │       │
              │       │               ▼              │       │
              │       │        Winston logger        │       │
              └───────┼───────────────┼──────────────┼───────┘
                      │               │              │
                  METRICS           LOGS          TRACES
                   (pull)      (stdout JSON)      (push)
                      │               │              │
              :9464 /metrics          │            OTLP
               Prometheus             │              │
               exposition             │              │
                      │               ▼              ▼
                      │             Alloy          Tempo
                      │               │              │
                      ▼               ▼              │
                 Prometheus         Loki             │
                      │               │              │
                      └───────────────┴──────────────┘
                                      │
                                   Grafana
```

### What the SDK actually provides

The three things inside the SDK box are the reason this is one system rather than three unrelated data streams from the same binary:

| | Feeds | Gives you |
|---|---|---|
| **Instruments** | metrics | The counters, histograms and gauges in §6 |
| **Context** | logs + traces | `trace_id` / `span_id` stamped on every log record |
| **Resource** | all three | `service.name`, `service.version`, `deployment.environment` applied identically to metrics, logs and traces |

**Logs are emitted by Winston, not by the OTel SDK.** This is a deliberate choice and the diagram should not be read otherwise:

```
✅ Winston → stdout JSON → Alloy → Loki        OTel *decorates* the record with trace context
❌ OTel Logs SDK → OTLP → Loki                 not used — more machinery, abandons container-native logging
```

`WinstonInstrumentation` only injects `trace_id`/`span_id` into records the existing logger already produces. `src/utils/logger.ts` remains the emitter; no log ever transits the OTel pipeline.

### 3.1 Per-signal transport matrix

Metrics, logs and traces are not the same decision. Only one of them is actually a choice:

| Signal | Transport | Is it a choice? |
|---|---|---|
| **Metrics** | **`/metrics` pull, Prometheus exposition format** | ✅ Yes — decided in §3.2 |
| Traces | OTLP push → Tempo | ❌ No pull-based alternative exists |
| Logs | stdout JSON → Alloy → Loki | ❌ Neither model applies; stdout is the container-native path |

A common confusion is treating "`/metrics` vs OTLP" as one decision covering all telemetry. It is not. OTLP will exist in the codebase regardless, because traces require it (Phase 6). That fact is what makes §3.4 cheap.

### 3.2 Decision: pull-based `/metrics` for metrics

**checkoutOs exposes metrics via a `/metrics` endpoint on port 9464, in Prometheus exposition format, using `@opentelemetry/exporter-prometheus` (an official OTel exporter). This is the default and the only transport required for a working deployment.**

#### 3.2.1 The decisive argument — telemetry must not be able to degrade the money path

A **push** exporter buffers metrics in-process and ships them on a timer. If the collector is slow, unreachable, or restarting, that buffer grows inside the Node process: memory pressure, retry timers, and export work competing with the event loop that is servicing `POST /payments`. Queue limits bound the damage, but the failure mode exists and it lives inside the payment service.

A **pull** endpoint has no queue. The SDK holds current values in memory and serialises them when scraped. If the scraper dies, checkoutOs is entirely unaffected — no buffer, no backpressure, no retry storm.

For a system that moves money, **the telemetry pipeline must never be able to add latency to the money path.** This is a design constraint, not a preference, and it settles the decision on its own.

#### 3.2.2 It makes §2.3 mechanical rather than aspirational

With pull, "nothing leaves the box by default" is not a policy someone has to honour — it is the physics of the design. There is no egress path to misconfigure. A push default would require every operator to consciously *not* configure an endpoint in order to stay private.

#### 3.2.3 Supporting rationale

| Factor | Why it favours pull for checkoutOs |
|---|---|
| **Deployment shape** | Long-running Express server with a stable network identity — the exact case pull was designed for. Not serverless, not ephemeral, not short-lived. |
| **OSS adoption friction** | `docker compose up` → open Grafana → graphs. A push default needs a Collector container and a config file before the first graph exists. |
| **Supportability** | "Paste the output of `curl localhost:9464/metrics`" is a complete bug report. There is no equivalent for push. |
| **Liveness for free** | The scraper's `up` metric tells you the service is alive. With push, absent data is ambiguous — dead app, or dead collector? |
| **Service count** | One service, one Redis, one gateway. A Collector's real value is fan-in and routing across many services; checkoutOs has none to fan in. |
| **Debuggability** | Metrics are inspectable in a browser during development, with no infrastructure running at all. |

#### 3.2.4 The irony worth noting

Pointing OTLP **directly** at a vendor intake (a Datadog endpoint plus an API key in application config) is *more* vendor coupling than the `/metrics` endpoint the format name suggests you are avoiding. The pull endpoint is the neutral option; see §3.3.

### 3.3 The exposition format is not a vendor

"Prometheus format" is a misleading name. The `/metrics` text exposition format is the de facto industry standard for pull-based metrics, and is consumed natively by:

- Prometheus
- Grafana Alloy / Grafana Agent
- **Datadog Agent** (the `openmetrics` check)
- OpenTelemetry Collector (`prometheusreceiver`)
- New Relic, Dynatrace, Vector, Telegraf, AWS CloudWatch agent

Exposing this format is therefore the **most** vendor-neutral option available, not a compromise. A single endpoint serves every branch of the architecture diagram. Working scrape configurations for four different consumers are given in §9 — that section exists specifically to make this claim verifiable rather than asserted.

### 3.4 Dual-reader design — pull by default, push available

An OTel `MeterProvider` accepts **multiple readers over one instrument set**. Business code defines instruments; only `src/telemetry/tracing.ts` decides where they go.

```ts
// src/telemetry/readers.ts
// Builds the reader list. Does NOT construct a MeterProvider — see the
// warning below. The list is handed to NodeSDK in tracing.ts.
//
// Imports `runtime`, never `config` — see §5 Phase 0 Prerequisites.

// ⚠️ preventServerStart is mandatory. Without it the exporter opens its OWN
// HTTP server on `port`, which then collides with metrics.server.ts (§3.5)
// on the same port: EADDRINUSE at boot. The exporter's built-in server also
// has no auth hook, so the bearer token in §3.5 would be unimplementable.
export const prometheusReader = new PrometheusExporter({
  preventServerStart: true,
  prefix: 'checkoutos',   // §6 namespace — without this, names render bare
});

export function buildMetricReaders(): MetricReader[] {
  return [
    // ── Pull: always on, zero config, no egress ──────────────────────────
    prometheusReader,

    // ── Push: opt-in, for enterprise pipelines. Off unless configured. ───
    ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter(),
            exportIntervalMillis: 60_000,
          }),
        ]
      : []),
  ];
}
```

> **⚠️ Do not construct a second `MeterProvider`.** `NodeSDK` registers its own
> global `MeterProvider` during `sdk.start()`. A standalone `new MeterProvider({...})`
> in `metrics.ts` plus a `NodeSDK` in `tracing.ts` gives two providers, and whichever
> registers last wins the global — silently. Every instrument obtained via
> `metrics.getMeter()` then reports to one provider while the `/metrics` endpoint
> serialises the other, and the endpoint returns an empty exposition with no error.
>
> **There is exactly one provider.** `buildMetricReaders()` returns readers;
> `tracing.ts` passes them to `NodeSDK` (see Phase 0). `metrics.ts` only calls
> `metrics.getMeter('checkoutos')` and defines instruments.

#### Which side owns the provider depends on the installed SDK

`NodeSDK` accepted a single `metricReader` before it accepted a `metricReaders` array. One reader is not enough for this design, so check before writing the bootstrap:

```bash
grep -n "metricReader" node_modules/@opentelemetry/sdk-node/build/src/types.d.ts
```

**If `metricReaders` (plural) exists — NodeSDK owns everything.** This is the preferred shape:

```ts
// src/telemetry/tracing.ts — the single owner
const sdk = new NodeSDK({ resource, metricReaders: buildMetricReaders(), instrumentations: [...] });
sdk.start();

// src/telemetry/metrics.ts — instruments only, never a provider
import { metrics } from '@opentelemetry/api';
const meter = metrics.getMeter('checkoutos');
export const paymentsCreated = meter.createCounter('payments.created', { … });
```

**If only `metricReader` (singular) exists — invert ownership.** Build the `MeterProvider` yourself, register it globally, and give `NodeSDK` no metrics configuration at all:

```ts
const meterProvider = new MeterProvider({ resource, readers: buildMetricReaders() });
metrics.setGlobalMeterProvider(meterProvider);                   // explicit, before sdk.start()
const sdk = new NodeSDK({ resource, instrumentations: [...] });  // no metricReader key
```

Either way the invariant is identical: **exactly one `setGlobalMeterProvider`, and `metrics.ts` never constructs a provider.** Record which branch was taken in a comment at the top of `tracing.ts`.

#### Make the silent failure loud — with a probe that travels the real path

This bug produces an empty or stale `/metrics` body and no error, so it cannot be left to review.

> **⚠️ Do not assert on `target_info`.** It is serialised from the *reader's own resource*, so it appears whenever the reader is attached to **any** provider — including the wrong one. The two-provider bug would pass that check. The assertion has to traverse the same path business code does: global meter → provider → reader → exposition.

Define a sentinel instrument through the global API in `metrics.ts`:

```ts
// src/telemetry/metrics.ts
meter.createObservableGauge('build.info')
  .addCallback((r) => r.observe(1, { version: runtime.version }));
```

Then assert its **rendered** name at boot — and send the bearer header, or the check returns 401 whenever `METRICS_AUTH_TOKEN` is set:

```ts
// after sdk.start(), non-test only
const token = runtime.metricsAuthToken;
const res = await fetch(`http://127.0.0.1:${runtime.metricsPort}/metrics`, {
  headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
});
if (!(await res.text()).includes('checkoutos_build_info')) {
  throw new Error('telemetry: instruments are not reaching the exposition');
}
```

`checkoutos_build_info` also proves the `prefix` from §3.4 is applied, so one assertion covers the namespace contract in §7 as well.

Failing startup is the correct response. A payment service running with dead telemetry it believes is live is worse than one that refuses to boot.

**Zero business-code difference between the two.** This is the §2.2 promise made mechanical: the OSS user gets a working endpoint with no configuration; an enterprise deployment sets one environment variable to also feed a Collector.

> **Temporality caveat.** Prometheus requires *cumulative* temporality; Datadog and several OTLP backends prefer *delta*. OTel applies temporality **per reader**, so the two coexist correctly — but the OTLP reader must be explicitly configured as delta when targeting such a backend, or counters will be misread. Document this next to the env var.

### 3.5 Endpoint exposure and authentication

**Port 9464, never port 3000.**

The API currently has no authentication. Publishing `/metrics` on the public listener would expose payment volumes, per-gateway error rates, and revenue shape to anyone who can reach the service.

Two layers of protection:

1. **Network isolation (default).** Bind the metrics listener to the internal Docker/Kubernetes network. In `docker-compose.yml`, do **not** publish 9464 to the host.
2. **Optional bearer token.** For deployments where network isolation is unavailable (shared clusters, some PaaS), support a token:

```
METRICS_AUTH_TOKEN=<random>     # unset → no auth, network isolation assumed
```

When set, the endpoint requires `Authorization: Bearer <token>`. Off by default because local scrape is the common case, but a scrapable business-metrics endpoint should never *lack the option* to be protected — particularly while the main API has no auth at all.

#### The listener owns the endpoint; the exporter only renders it

Because §3.4 constructs the exporter with `preventServerStart: true`, `metrics.server.ts` is a plain `http` server that mounts the exporter's request handler. This is what makes auth possible at all:

```ts
// src/telemetry/metrics.server.ts
import { prometheusReader } from './readers';
import { runtime } from '../config/runtime';

const expected = runtime.metricsAuthToken;

export const metricsServer = http.createServer((req, res): void => {
  if (expected !== undefined) {
    const got = req.headers.authorization ?? '';
    const want = `Bearer ${expected}`;
    // Constant-time: this is the only auth check in the codebase and it
    // guards payment volumes and revenue shape.
    const ok =
      got.length === want.length &&
      crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
    if (!ok) { res.writeHead(401).end(); return; }
  }
  if (req.url === '/metrics') { prometheusReader.getMetricsRequestHandler(req, res); return; }
  res.writeHead(404).end();
});

metricsServer.listen(runtime.metricsPort);
```

Close it in the existing graceful-shutdown sequence (`server.ts:50`) alongside `server.close()`.

#### Config wiring

Add `METRICS_PORT` and `METRICS_AUTH_TOKEN` to `BaseEnvSchema` in `env.schema.ts` following the existing Zod patterns (`METRICS_PORT` uses `z.coerce.number().int()` with the same 1024–65535 bounds as `PORT`, default 9464), and to `.env.example`.

Expose them through `config/index.ts` as a `config.metrics` group — `config.metrics.port`, `config.metrics.authToken` — matching the existing grouping convention (`config.redis.url`, `config.webhook.relayUrl`).

**`src/telemetry/` reads `config/runtime.ts`, not `config/index.ts`** — see §5 Phase 0 Prerequisites. `runtime.ts` is still config; it is simply the dependency-free half, which is what keeps the telemetry bootstrap from loading `winston` before it can instrument it. Zod still validates every one of these values at startup, so fail-fast is unchanged.

#### Every environment variable this plan introduces

Collected here so the `.env.example` and `env.schema.ts` diffs can be written in one pass:

| Variable | Default | Zod | Exposed as | Introduced by |
|---|---|---|---|---|
| `METRICS_PORT` | `9464` | `z.coerce.number().int().min(1024).max(65535)` | `config.metrics.port` + `runtime.metricsPort` | Phase 2 |
| `METRICS_AUTH_TOKEN` | unset | `z.string().optional()` | `config.metrics.authToken` + `runtime.metricsAuthToken` | Phase 2 |
| `APP_VERSION` | `'0.0.0'` | `z.string().default('0.0.0')` | `config.app.version` + `runtime.version` | Phase 0 — `service.version` **and** the `version` log field |
| `LOG_FORMAT` | TTY-derived | `z.enum(['json','pretty']).optional()` | `config.log.format` + `runtime.logFormat` | Phase 1a |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | **none** — OTel standard | read in `src/telemetry/` only | §3.4 / Phase 6 |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | set by the app | **none** — OTel standard | set in `tracing.ts` (§5 Phase 2b) | Phase 2 |

**There is no `process.env` exception for `LOG_FORMAT`.** An earlier revision claimed `config/index.ts` imports the logger and therefore the logger could not depend on config. That is backwards: `config/index.ts` imports zod, `env.schema`, types and the registry — never the logger — while `logger.ts:4` imports config. The values above are read once in `config/runtime.ts` and reached everywhere else through `config`, preserving the rule that only `config` touches `process.env`.

The genuine restriction is the opposite one, and it is about **load order, not layering**:

> `src/utils/logger.ts` and `src/telemetry/**` may import `config/runtime.ts`. They must **never** import `config/index.ts`. Enforce with `import/no-restricted-paths` rather than prose — §5 Phase 0 Prerequisites explains what breaks otherwise.

### 3.6 Signal correlation — what works, and what does not

Converging all three signals on Grafana looks like full correlation. It is not. Two of the three pivots work out of the box; the third needs configuration this plan defers.

| Pivot | Works? | Mechanism |
|---|---|---|
| Loki → Tempo | ✅ | `trace_id` in the log line |
| Tempo → Loki | ✅ | same, in reverse |
| Prometheus → Tempo | ❌ | **requires exemplars** — see below |
| Prometheus ↔ Loki | ⚠️ manual | No shared key; pivot by time range and `service`/`env` labels |

#### The missing edge: metrics → traces

You will be able to see *"gateway p99 latency spiked"* and you will be able to read traces — but you cannot jump from the slow histogram bucket to **an example of a slow request**. During an incident that is the single most useful pivot, and it is the one absent.

Closing it requires all of:

- Prometheus started with `--enable-feature=exemplar-storage`
- OpenMetrics exposition format with exemplars attached
- OTel JS exemplar support, which is uneven across releases

Deferred to Phase 6 (§12). Documented here so the gap is a known limitation rather than a surprise at 3am.

#### Before Tempo exists, `trace_id` is a grouping key, not a navigation key

`WinstonInstrumentation` stamps `trace_id` on every log record from Phase 1 onward, whether or not traces are exported anywhere. That is genuinely useful — it groups every log line belonging to one request in Loki:

```logql
{service="checkoutos"} | json | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"
```

But until Tempo is deployed (Phase 6) there is nothing to click *through* to. Do not expect trace navigation after Phase 1; expect request-scoped log grouping.

---

### 3.7 Deployment topologies and revisit triggers

The instrumentation layer is deployment-agnostic; only the **export path** varies by target. This table records which targets are supported today, what each costs, and which are explicitly out of scope.

| Topology | Metrics export | Status | Cost to support |
|---|---|---|---|
| **Long-running container** (Docker, Kubernetes, VM) | `/metrics` pull, §3.2 | ✅ **Supported — the default** | Zero; it is the plan |
| **Serverless** (Lambda + ADOT, Cloud Run, Azure Functions) | OTLP push, §3.4 | ✅ **Supported — opt-in** | Set `OTEL_EXPORTER_OTLP_ENDPOINT`; configure the OTLP reader as **delta** temporality (§3.4) |
| **Edge / V8 isolate** (Cloudflare Workers, Deno Deploy) | n/a | ❌ **Out of scope** | Not an observability task — see §3.7.1 |

Because the dual-reader design (§3.4) already covers both supported topologies, no additional abstraction is required to move between them. See §2.4 on why one should not be added.

#### 3.7.1 Why edge runtimes are out of scope

Edge support is blocked by the **application**, not by the telemetry layer. checkoutOs cannot execute on a V8 isolate runtime today:

| Blocker | Location | Why it fails on a V8 isolate |
|---|---|---|
| `crypto.createHmac`, `crypto.timingSafeEqual` | `razorpay.plugin.ts:4, 295, 302` | Isolates provide WebCrypto, not `node:crypto`. Porting to `crypto.subtle` makes verification **async**, which changes `GatewayPlugin.parseWebhookEvent()` (`gateway.types.ts:128`) from sync to async — a breaking change across every plugin and test. |
| `express` | `app.ts:19` | No `node:http` server; edge runtimes use `fetch()` handlers |
| `ioredis` | `redis.client.ts:8` | Raw TCP sockets; would require an HTTP-based Redis or `cloudflare:sockets` |
| `paytmchecksum` | `paytm.plugin.ts:9` | Node library with the same `node:crypto` dependency |
| `Buffer.*` | `webhooks.controllers.ts`, `webhook.service.ts`, both plugins | Not a global in edge runtimes |
| `winston` | `logger.ts` | Node-only transports |

Supporting edge would additionally require a **second telemetry implementation** — `@opentelemetry/sdk-trace-web` in place of `sdk-node`, with no Node auto-instrumentation, no `PrometheusExporter`, and no `IORedisInstrumentation`.

**Consequence:** should edge deployment become a roadmap item, the table above is the backlog, and it is an application-architecture project that would *precede* any observability work — not follow from it. Do not pre-build telemetry branches for this target.

#### 3.7.2 Revisit triggers

The pull-by-default decision (§3.2) should be re-opened if any of the following becomes true:

- **Serverless / FaaS becomes a primary deployment target** — no stable scrape target; push becomes the default rather than an option
- **Per-merchant metric routing** in a hosted multi-tenant offering — a Collector's routing earns its keep
- **Five or more services** — fan-in and centralised pipeline configuration start to pay for themselves

None of these describe the MVP.

---

## 4. Where the code lives

```
src/config/
  runtime.ts            # NEW — dependency-free runtime facts. Imported by
                        #   logger.ts and src/telemetry/. Has NO imports of its
                        #   own; that absence is the invariant (§5 Phase 0 Prereq).

scripts/
  verify-telemetry.mjs  # spawns the real start/dev commands and asserts
                        #   instrumentation actually patched (§5 Phase 0)

src/telemetry/
  tracing.ts            # NodeSDK bootstrap — MUST load before all other imports.
                        #   The ONLY file that owns a provider (§3.4).
                        #   Imports config/runtime.ts, NEVER config/index.ts.
  register.mjs          # ESM loader hook for dev (see §5 Phase 0)
  readers.ts            # buildMetricReaders() — reader list only, no provider (§3.4)
  metrics.ts            # instrument definitions only — getMeter() + create*() (§3.4)
  buckets.ts            # explicit histogram boundaries (§5 Phase 2)
  attributes.ts         # allow-listed label builders (§8)
  gateway.decorator.ts  # withTelemetry(plugin) — see §6.1
  metrics.server.ts     # :9464 listener + optional bearer auth (§3.5)
  index.ts
```

**Not `src/utils/`.** AGENTS.md defines utils as pure functions with no side effects; emitting telemetry is a side effect. `src/telemetry/` is a peer layer with the same standing as `src/store/`.

### Layer placement, consistent with existing architecture rules

| Layer | Instrumentation approach |
|---|---|
| Controllers | None directly — HTTP metrics come from middleware |
| Middleware | HTTP RED metrics (`request-logger.ts`, currently an empty file) |
| Services | Domain metrics — services own business logic, so they own business signals |
| Gateways | **Decorator at the registry**, never inside plugin files (§6.1) |
| Store | Automatic via `IORedisInstrumentation` |
| Utils | Nothing — stays pure |

---

## 5. Implementation phases

### Phase 0 — Prerequisites, foundations, and the ESM trap · ~2 days

#### ⚠️ Prerequisites — `npm start` does not run today

Two pre-existing defects block this phase. Both were reproduced on the tree at `a7f18a3`; neither is an observability problem, and neither can be worked around from inside `src/telemetry/`.

**Blocker A — the compiled output cannot execute.** `package.json` declares `"type": "module"` while `tsconfig.json` emits `"module": "CommonJS"`, so Node parses `dist/*.js` as ESM and dies on line 2 of the first file:

```
ReferenceError: exports is not defined in ES module scope
```

`npm start` is broken, and so is the production container — `Dockerfile:69` is `CMD ["node", "dist/server.js"]`. The plan's own production bootstrap (`node --require ./dist/telemetry/tracing.js dist/server.js`) is written against a build that does not run, and `--require` is CJS-only besides.

*Fix — stamp the output directory, no source changes:*

```jsonc
"build": "tsc && node -e \"require('fs').writeFileSync('dist/package.json','{\\\"type\\\":\\\"commonjs\\\"}')\""
```

`tsx` dev is unaffected, every relative import in `src/` stays as it is, and `--require` becomes available. (The alternative — moving to real ESM with `"module": "NodeNext"` — requires adding `.js` extensions to every relative import across ~60 files and is a larger project than this plan.)

**Blocker B — a circular dependency that only CommonJS exposes.** With Blocker A fixed, startup gets further and then throws `TypeError: Cannot convert undefined or null to object` from zod. `madge --circular src/server.ts` reports exactly one cycle:

```
config/index.ts → config/env.schema.ts → gateways/gateway.registry.ts
                → gateways/paytm/paytm.plugin.ts → utils/logger.ts → (config/index.ts)
```

ESM tolerates it through hoisting and live bindings. CommonJS does not: `env.schema.ts` receives a half-initialised registry, `supportedGateways` is `undefined`, and `z.enum(undefined)` throws.

**The back edge is `logger.ts:4` importing `config` — and it is the same edge that would defeat instrumentation** (see the import-order warning below). One change closes both:

```ts
// src/config/runtime.ts
// Runtime facts with NO imports. That absence is the invariant: it is what lets
// logger.ts and src/telemetry/ load without dragging in env.schema →
// gateway.registry → the plugins → winston and axios.

const nodeEnv = process.env['NODE_ENV'] ?? 'development';

export const runtime = {
  env: nodeEnv,
  isTest: nodeEnv === 'test',
  isDevelopment: nodeEnv === 'development',
  isProduction: nodeEnv === 'production',
  version: process.env['APP_VERSION'] ?? '0.0.0',
  logFormat: process.env['LOG_FORMAT'],
  metricsPort: Number(process.env['METRICS_PORT'] ?? 9464),
  metricsAuthToken: process.env['METRICS_AUTH_TOKEN'],
} as const;
```

`logger.ts` and `src/telemetry/` import `runtime`; `config/index.ts` re-exports these values into the `config` object so **every existing business call site keeps reading `config.env` unchanged**. Zod continues to validate all of them at startup — `runtime.ts` is only the early-read path for the two modules that must load before `config` exists.

**Acceptance for the prerequisites, before any OTel code is written:**

```bash
npm run build && node dist/server.js          # must reach "server started", not a module error
npx madge --extensions ts --circular src/server.ts   # must report 0 cycles
```

These two steps are worth doing whether or not observability ships. They fix a production image that cannot start.

---

**Deliverables:** the prerequisites above, `src/telemetry/` skeleton, dependencies, working module patching, `scripts/verify-telemetry.mjs`, this document merged, **and an `AGENTS.md` update**.

`AGENTS.md` is the contract every contributor and agent reads first, and it currently has no notion of a telemetry layer. Phase 0 must add to it:

- `src/telemetry/` to **§Architecture Rules**, as a peer of Store, with its own rule: *only `src/telemetry/tracing.ts` may name an exporter; business code emits through the OTel API and names no destination* (§2.4).
- The reinforcement that **Utils stays pure** — telemetry emission is a side effect and never belongs there (§4).
- **§Gateway Rules:** gateway instrumentation comes from the registry decorator (§6.1). *Never add metrics inside a plugin file.* This preserves the existing rule that adding a gateway = registry entry + plugin file only.
- **§Engineering Rules:** metric labels come only from `src/telemetry/attributes.ts` builders (§8.2).

Without this, the first contributor to add a gateway re-introduces exactly the per-plugin instrumentation §6.1 exists to prevent — and they will be following the guide correctly when they do it.

Dependencies:

The bootstrap below constructs each instrumentation individually, so list the
individual packages — **not** `auto-instrumentations-node`. Shipping the bundle
*and* hand-constructing four of its members pulls in a dozen unused patchers and
makes it ambiguous which set is actually active.

```
@opentelemetry/sdk-node
@opentelemetry/sdk-trace-base               # SpanProcessor interface (no-op processor)
@opentelemetry/exporter-prometheus          # the default metrics path
@opentelemetry/exporter-metrics-otlp-http   # opt-in push (§3.4)
@opentelemetry/exporter-trace-otlp-http     # traces (Phase 6)
@opentelemetry/instrumentation-http
@opentelemetry/instrumentation-express
@opentelemetry/instrumentation-winston
@opentelemetry/instrumentation-ioredis
@opentelemetry/resources
@opentelemetry/semantic-conventions
```

Install every one with `-E`. See the probe step below.

#### ⚠️ ESM/CJS module patching — budget real time for this

The project is `"type": "module"` with CommonJS output via `tsc`, and `tsx` bridging at dev time. OTel auto-instrumentation patches modules at require/import time. **Under ESM it silently no-ops unless the loader hook is registered** — the SDK starts, no error is raised, and no spans appear.

```jsonc
// production (CJS output) — require-based patching works
"start": "node --require ./dist/telemetry/tracing.js dist/server.js"

// dev (tsx/ESM) — needs the hook, or instrumentation silently does nothing
"dev": "tsx --import ./src/telemetry/register.mjs watch src/server.ts"
```

**Acceptance test:** an automated check asserting a span exists for `GET /health`. Without it, a silent regression here is undetectable.

#### SDK bootstrap

```ts
// src/telemetry/tracing.ts — the ONLY file that names an exporter (§2.4)
// Imports config/runtime.ts, NEVER config/index.ts (Prerequisites, above).

// Stable HTTP semconv. Must be set BEFORE constructing HttpInstrumentation —
// see §5 Phase 2b for why this is not optional.
process.env['OTEL_SEMCONV_STABILITY_OPT_IN'] = 'http';

// Until Phase 6 there is no trace destination. An explicit no-op processor is
// how we say that; see the egress warning below for why the obvious
// alternatives are wrong. Four methods, version-proof.
class NoopSpanProcessor implements SpanProcessor {
  onStart(): void {}
  onEnd(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'checkoutos',
    [ATTR_SERVICE_VERSION]: runtime.version,        // APP_VERSION, not pkg.version
    'deployment.environment.name': runtime.env,
  }),
  // Phase 0–5: spans are created (so trace_id exists) but exported nowhere.
  // Phase 6 replaces this with BatchSpanProcessor + OTLP.
  spanProcessors: [new NoopSpanProcessor()],
  // Metrics readers from §3.4 — one provider, owned by NodeSDK.
  metricReaders: buildMetricReaders(),
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new IORedisInstrumentation(),
    // disableLogSending is REQUIRED — see the egress warning below.
    new WinstonInstrumentation({ disableLogSending: true }),
  ],
});

if (!runtime.isTest) { sdk.start(); }
```

##### ⚠️ The SDK's defaults contradict §2.3 — two of them

Both need confirming in the probe step, then handling explicitly. Neither is hypothetical: they are what a `NodeSDK` with no exporter configuration does on its own.

**Traces default to OTLP on `localhost:4318`.** Given no `traceExporter` and no span processor, `NodeSDK` configures exporters from `OTEL_TRACES_EXPORTER`, whose default is `otlp`. From Phase 0 onward that means an in-process export buffer plus a steady stream of `ECONNREFUSED` retries — violating **§2.3** (nothing leaves the box by default) and **§3.2.1** (telemetry must never add latency to the money path), which are the two claims the entire pull-based argument rests on.

> **Do not "fix" this with `OTEL_TRACES_EXPORTER=none`.** In some releases that skips registering a tracer provider at all, which removes `trace_id` from every log record — silently destroying the Phase 1 deliverable. The explicit no-op processor above keeps real trace IDs while exporting nothing.

**`WinstonInstrumentation` forwards log records by default.** Unless `disableLogSending: true` is passed, it pushes records into the OTel Logs pipeline — directly contradicting §3's *"no log ever transits the OTel pipeline."* Trace-context injection is a separate option (`disableLogCorrelation`, left at its default `false`), so disabling sending costs nothing we want.

**Assertion:** before Phase 6, nothing should be listening on `localhost:4318`. Add that to `scripts/verify-telemetry.mjs`.

##### ⚠️ Probe the API before writing this file — do not write a shim

The JS SDK broke these exact symbols at 2.0. Rather than guessing or building a
compatibility layer, install first and ask the packages what they export:

```bash
npm i -E @opentelemetry/sdk-node @opentelemetry/resources @opentelemetry/semantic-conventions

node -e "
const r = require('@opentelemetry/resources');
const s = require('@opentelemetry/semantic-conventions');
console.log('resourceFromAttributes:', typeof r.resourceFromAttributes);  // 2.x
console.log('Resource class        :', typeof r.Resource);                // 1.x
console.log('ATTR_SERVICE_NAME     :', s.ATTR_SERVICE_NAME);              // 2.x
console.log('SEMRESATTRS_*         :', s.SEMRESATTRS_SERVICE_NAME);       // 1.x
"
```

Whichever pair is defined is the API to write against. Write it once; do not
branch on both.

Probe the **exporter defaults** in the same pass, since they drive the egress
warning below:

```bash
node -e "
const s = require('@opentelemetry/sdk-node');
console.log('OTEL_TRACES_EXPORTER  default:', process.env.OTEL_TRACES_EXPORTER  ?? '(unset)');
console.log('OTEL_LOGS_EXPORTER    default:', process.env.OTEL_LOGS_EXPORTER    ?? '(unset)');
console.log('OTEL_METRICS_EXPORTER default:', process.env.OTEL_METRICS_EXPORTER ?? '(unset)');
"
grep -rn "otlp" node_modules/@opentelemetry/sdk-node/build/src/TracerProviderWithEnvExporter.js | head
```

Record what the resolved version actually does. If it does **not** default to
OTLP, the no-op span processor is still correct — it just becomes belt-and-braces
rather than load-bearing.

| Concern | Rule |
|---|---|
| **Version pinning** | `-E` on **every** `@opentelemetry/*` package. These are independently versioned, and a caret range will drift across the 2.0 boundary on a routine `npm install` — breaking the build with no code change of your own. |
| **`deployment.environment.name`** | Use the **string literal**, as in the bootstrap above. The typed constant lives in `@opentelemetry/semantic-conventions/incubating`, and incubating export paths move between releases. The attribute key itself is stable; one literal is cheaper than a broken import. |
| **`metricReaders` vs `metricReader`** | Decides which side owns the provider — see §3.4. |
| **Record the result** | Write the resolved versions into this section once installed, so the next reader knows which API the code targets. |

##### ⚠️ `pkg.version` will not compile here

`import pkg from '../package.json'` fails on two counts in this repo: `rootDir: "src"`
puts `package.json` outside the TypeScript program, and `resolveJsonModule` is not
enabled in `tsconfig.json`. Enabling either one to read a version string is not worth it.

Add `APP_VERSION` to `env.schema.ts` (`z.string().default('0.0.0')`) and set it from a
Docker build arg. Business code reads it as `config.app.version` alongside the existing
`config.app.baseUrl`; **`tracing.ts` and `logger.ts` read `runtime.version`** instead,
because neither may import `config/index.ts` (Prerequisites, above). One env var, two
read paths, same value — and Zod still validates it at startup.

The same value feeds `service.version` here and the `version` field on every log
record (§5 Phase 1a).

`IORedisInstrumentation` is a free win: because the store boundary is clean (only `src/store/*` imports `redisClient`), every store operation is traced without touching `payment.store.ts`, `refund.store.ts`, or `idempotency.store.ts`.

#### ⚠️ Telemetry must be off in tests — and `IORedisInstrumentation` is why

"Wire a no-op path when `config.isTest`" understates this. `vitest.setup.unit.ts:23` does `vi.mock('ioredis')` → `ioredis-mock`, and `IORedisInstrumentation` patches the `ioredis` module at load. Two module-level interceptors racing for the same specifier will either no-op or corrupt the mock depending on load order, and the symptom is a test suite that fails intermittently for reasons unrelated to the test.

The rule is stronger than a no-op exporter: **the SDK must never `start()` under vitest.**

- Neither vitest project loads `tracing.ts` today (there is no `--require` hook and no `--import` in the vitest invocation), so the default is already correct — the job is to keep it that way.
- Guard `sdk.start()` behind `runtime.isTest` **anyway**, so an accidental `import '@/telemetry/tracing'` from a test helper cannot arm it. One line, and it makes the property enforced rather than incidental:

  ```ts
  // src/telemetry/tracing.ts
  if (!runtime.isTest) { sdk.start(); }
  ```

- Do **not** add telemetry bootstrap to `tests/helpers/app.helper.ts`. `createTestApp()` calls `buildApp()` only, and that separation is what keeps the app factory side-effect free (AGENTS.md: *"`buildApp()` is a pure factory with no side effects"*).
- Instruments defined in `metrics.ts` must be safe to construct with no provider registered — the OTel API returns no-op instruments in that case, so `.add()` / `.record()` from a service under unit test is a silent no-op. Verify this rather than assuming it; it is what lets service tests run unchanged.

##### The acceptance check must spawn the real commands — not a vitest project

An earlier revision specified a third vitest project that boots a hand-built
`NodeTracerProvider` with an `InMemorySpanExporter`. **That test cannot fail for the
reason it exists.** It never loads `tracing.ts`, never loads `register.mjs`, and never
runs `npm start` or `npm run dev` — so it passes happily while production emits
nothing. The thing under test *is* the bootstrap wiring, and only the real entry
points exercise it.

`scripts/verify-telemetry.mjs`, run against **both** entry points:

```
for cmd in ["npm start", "npm run dev"]:
  spawn cmd; wait for :3000/health to answer
  GET  http://localhost:3000/health
  GET  http://localhost:9464/metrics        (with bearer header if configured)

  assert body contains  http_route="/health"      → HttpInstrumentation patched
  assert body contains  checkoutos_build_info     → provider wiring intact (§3.4)
  assert nothing is listening on localhost:4318   → no default OTLP egress (above)

  kill; non-zero exit on any failure
```

Asserting on the **metrics** exposition rather than on spans is what lets this work
with no trace exporter configured, and it proves patching end-to-end through the
compiled artefact. Wire it as `npm run verify:telemetry` and run it in CI.

Since `npm test` is still the `exit 1` placeholder, CI must name the scripts
explicitly: `test:unit && test:integration && verify:telemetry`.

**This is the highest-value check in the plan.** It is the only thing standing between
the team and ESM patching silently no-opping after a future dependency bump — a
failure mode that produces no error of any kind. It would also have caught both
prerequisite blockers above on day one.

##### ⚠️ Import order can defeat patching even when the hook is correct

The prerequisites removed the dangerous edge (`logger.ts` → `config`), but the
property needs guarding, because anything `tracing.ts` imports is loaded *before*
`sdk.start()` and therefore before the patchers exist. If `winston` loads early, the
logger instance is constructed unpatched and **no log record ever carries
`trace_id`** — silently.

Keep `tracing.ts`'s import list to `runtime` and the OTel packages, and add a
backstop immediately before `start()`:

```ts
const early = Object.keys(require.cache)
  .filter((k) => /node_modules[\\/](winston|ioredis|express)[\\/]/.test(k));
if (early.length) {
  throw new Error(`telemetry: loaded before instrumentation: ${early.join(', ')}`);
}
```

`require.cache` is CJS-only, which is exactly the production path after the Blocker A
fix. Under `tsx`/ESM the guard is inert, which is why `verify-telemetry.mjs` runs
`npm run dev` as well.

---

### Phase 1 — Structured logs into Loki · ~2 days

#### 1a. Fix the logger (`src/utils/logger.ts`)

1. **Emit JSON whenever a log destination is configured**, not only when `NODE_ENV=development` is false. `logger.ts:37` selects colourised human-readable output in development, which Loki cannot parse — meaning nobody will build or test dashboards locally. Gate on an explicit `LOG_FORMAT=json|pretty` (defaulting to `pretty` only for a TTY), not on `NODE_ENV`.
2. **Attach `service`, `env`, `version` to every record**, so Loki labels derive from the log itself rather than scraper configuration.
3. **Standardise on a structured `event` field.**
4. **Fix `logger.ts:35`.** `level: config.isTest ? 'silent' : ...` names a level that does not exist in winston's `npm` levels (`error·warn·info·http·verbose·debug·silly`). It is inert today only because the Console transport separately sets `silent: config.isTest`. Use `silent: true` on the logger, or a real level.
5. **Switch `logger.ts` from `config` to `config/runtime.ts`.** This is the back edge of the circular dependency in §5 Phase 0 Prerequisites; Phase 1a is where it gets cut.

Today the codebase mixes two styles. Most of it uses prose:

```ts
log.info('Payment created', { chkId, ... });
```

while `idempotency.service.ts` uses dotted event names:

```ts
log.info('idempotency.miss', { key, requestHash });
```

The dotted form is correct — it is queryable and stable.

##### ⚠️ The object-literal shape does not compile — but the signature need not change

`logger.ts:6-11` types every method as `(message: string, meta?: Record<string, unknown>) => void`, so `log.info({ event: 'payment.created', … })` is a **type error**, not a style preference.

**The insight that makes this cheap:** `(event: string, fields?: Record<string, unknown>)` is *structurally identical* to the current signature. Rename the parameters for clarity and **all 75 call sites keep compiling untouched**. The event-name rename then becomes a pure string-literal pass, fully separable from the structural change.

The second problem is the real unlock. `logger.ts:54` emits `` `[${context}] ${message}` ``, so the JSON field Loki sees is `"message": "[webhook] Webhook received"` — not a queryable event name. `component` and `event` must become their own fields.

Both are fixed by changing **only the body of `createContextLogger` and the `createLogger` options**:

```ts
// src/utils/logger.ts

type LogFields = Record<string, unknown>;

type ContextLogger = {
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
  debug: (event: string, fields?: LogFields) => void;
};

// Pretty output must strip the base fields, or dev logs become unreadable once
// defaultMeta starts injecting service/env/version onto every record.
const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ level: true }),
  winston.format.printf(({ timestamp, level, message, component, ...meta }): string => {
    delete meta['service'];
    delete meta['env'];
    delete meta['version'];
    delete meta['event'];                       // duplicated into message — see below
    const metaStr = Object.keys(meta).length > 0 ? '  ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}] [${String(component)}] ${message}${metaStr}`;
  }),
);

// JSON serialisation for shipped logs. format.errors() only unwraps a
// top-level Error — an Error nested in fields serialises as {}, which loses
// every stack trace a payments incident needs.
const serializeErrors = winston.format((info) => {
  for (const [k, v] of Object.entries(info)) {
    if (v instanceof Error) {
      info[k] = {
        name: v.name,
        message: v.message,
        stack: v.stack,
        ...(v instanceof AppError && { code: v.code, details: v.details }),
      };
    }
  }
  return info;
})();

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  serializeErrors,
  winston.format.json(),
);

// Decide by capability, not by NODE_ENV — item 1 above.
// runtime, not config: logger.ts must not import config/index.ts (Phase 0 Prereq).
const useJson =
  runtime.logFormat === 'json' ||
  (runtime.logFormat !== 'pretty' && !process.stdout.isTTY);

export const logger = winston.createLogger({
  level: runtime.isDevelopment ? 'debug' : 'info',
  silent: runtime.isTest,                       // fixes the bogus level: 'silent'
  defaultMeta: {
    service: 'checkoutos',
    env: runtime.env,
    version: runtime.version,                   // APP_VERSION — see Phase 0
  },
  format: useJson ? prodFormat : devFormat,
  transports: [new winston.transports.Console()],
  exitOnError: false,
});

export function createContextLogger(component: string): ContextLogger {
  const emit = (
    level: 'info' | 'warn' | 'error' | 'debug',
    event: string,
    fields?: LogFields,
  ): void => {
    // ⚠️ Fields spread FIRST. With `{ event, component, ...fields }` a call site
    // passing its own `event` key silently overwrites the dotted name — and
    // webhook.service.ts does exactly that at five call sites (see below).
    //
    // `event` is duplicated into `message` deliberately: Loki queries `event`,
    // humans read `message`, and neither needs a custom winston format.
    logger.log(level, event, { ...fields, event, component });
  };

  return {
    info: (event, fields): void => emit('info', event, fields),
    warn: (event, fields): void => emit('warn', event, fields),
    error: (event, fields): void => emit('error', event, fields),
    debug: (event, fields): void => emit('debug', event, fields),
  };
}
```

Resulting record:

```json
{"level":"info","message":"webhook.received","event":"webhook.received",
 "component":"webhook","service":"checkoutos","env":"production","version":"1.0.0",
 "trace_id":"…","span_id":"…","gateway":"razorpay"}
```

##### Three traps this surfaces

**`runtime.version`, not `pkg.version` and not `config.app.version`.** `import pkg from '../package.json'` does not compile under `rootDir: "src"` without `resolveJsonModule`; and `logger.ts` must not import `config/index.ts` at all (Phase 0 Prerequisites — it is the back edge of the circular dependency). Read `APP_VERSION` through `config/runtime.ts`.

**Five call sites already pass their own `event` key.** `webhook.service.ts:84, 145, 186, 199, 209` all log `event: event.event` — the gateway's event name. Under the wrong spread order every one of them silently replaces the dotted event in Loki, and these are precisely the records §6.3's webhook metrics are derived from. Two defences, both required: fields spread first (above), and the codemod renames these keys to `gatewayEvent`. Grep for `event:` and `component:` in log metadata before running the rename.

**`app.ts:49` calls `log[level](…)` with a computed level.** It still typechecks, but it is the one call site where the event name cannot be a plain literal. Give it a fixed event and move the severity into the fields:

```ts
log[level]('http.request.completed', { method, route: req.route?.path, statusCode, latencyMs });
```

Note `req.route?.path`, not `req.path` — the same cardinality trap as §5 Phase 2b, and this is the line it lives on.

**Both vitest setups mock the logger — and the fix is to delete both mocks.** `vitest.setup.unit.ts:36-49` *and* `vitest.setup.integration.ts` each hand-stub `logger` and `createContextLogger`. Updating them re-creates the coupling; `silent: runtime.isTest` already does the job, and the unit setup's own comment calls its mock *"belt-and-suspenders."* Remove both `vi.mock('./src/utils/logger', …)` blocks in this commit. That permanently decouples the suites from the logger's shape, so no future logger change can break them again.

##### Scope of the rename, and how to land it

**75 `log.*` call sites across `src/`, ~73 distinct event names** — not ~53. Nineteen are already dotted; the remaining ~56 are prose. All are renamed under a fixed namespace set: `payment.*`, `webhook.*`, `refund.*`, `gateway.*`, `idempotency.*`, `orderid.*`, `redis.*`, `server.*`, `health.*`.

> **The dotted ones do not all map to themselves.** Sixteen of the nineteen contain underscores (`idempotency.race_condition_retry_exhausted`, `idempotency.stale_in_progress`, …) — fine, and the lint rule below permits them. But three are `orderId.amount_mismatch`, `orderId.currency_mismatch` and `orderId.dedup_hit`: a capital `I`, violating the `orderid.*` namespace this plan declares. Rename those three with the rest.

**Make the mapping data, not edits.** Generate the current set, fill in targets, apply mechanically:

```bash
grep -rhoE "log\.(info|warn|error|debug)\('[^']*'" src --include='*.ts' \
  | sed -E "s/log\.[a-z]+\('//;s/'$//" | sort -u > /tmp/events.txt
```

Turn that into `scripts/event-map.json` (`"Payment created": "payment.created"`), then a ~20-line script applies it across `src/`. **Review the map, not the diff** — 73 lines instead of 75 scattered hunks.

**Land it as one commit touching only log call sites.** `git diff --stat` should show `src/**` plus the two vitest setups and nothing else; any logic change hiding in that commit is a review failure.

**Prevent regression with a lint rule,** or the next contributor writes prose again:

```js
// eslint.config.js — src/**/*.ts
'no-restricted-syntax': ['error',
  {
    // Requires at least one dot; allows underscores within segments; lowercase only.
    selector:
      "CallExpression[callee.object.name='log'] > Literal:first-child" +
      ":not([value=/^[a-z][a-z0-9]*(_[a-z0-9]+)*(\\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$/])",
    message: 'Log event must be dotted lowercase (payment.created) — see ADR 003 §5 Phase 1a',
  },
  {
    selector: "CallExpression[callee.object.name='log'] > TemplateLiteral:first-child",
    message: 'Log event names must be static literals, not template literals',
  },
],
```

> **Test the selector against a fixture before merging it.** A naive `[value=/[^a-z0-9.]/]` — which an earlier revision of this plan proposed — rejects every underscore and would have failed **16 of the 19 events that are already correct.** Build the fixture from the enumeration command above so the rule is validated against real data rather than an example.

Do it while no gateway branch is in flight — it conflicts with everything. See §11 for the reordering that de-risks it.

#### 1b. Remove debug noise before it becomes indexed and retained

- `server.ts:24-28` — `console.log('ENV DEBUG:', ...)` printing `ACTIVE_GATEWAY`, `REDIS_URL`, `WEBHOOK_RELAY_URL` on every boot
- `health.service.ts:36` — `log.debug('Sumit debug', { gatewayResult })`
- `razorpay.plugin.ts:99-105` — `console.error` dumping full API response bodies (see §8 on PCI scope)
- `razorpay.plugin.ts:218-225, 235` — a second `console.log` block dumping the refund request (`gatewayPaymentId`, amount, full URL) and the created refund id. Missed by an audit that greps only for `console.error`.
- `bootstrap.ts:9, 11` — `console.warn`/`console.log` on env load. Harmless content, but it is unstructured output that Alloy will ship to Loki as an unparseable line. Route through the logger or drop it.

`config/index.ts:19-24` also writes directly to `console.error`, and **should stay that way** — it runs before the logger can exist and its job is to be readable by a human staring at a crashed container.

#### 1c. Ship logs

Grafana Alloy reading container stdout → Loki. (Promtail is deprecated; do not introduce it.) Loki also accepts OTLP natively at `/otlp/v1/logs` if a Collector is already in the pipeline — either is acceptable; Alloy is less to explain to contributors.

**Deliverable:** every log line queryable in Loki, carrying `trace_id`.

---

### Phase 2 — The `/metrics` endpoint and HTTP RED · ~1.5 days

This phase delivers the endpoint decided in §3.2 and the first metrics on it.

#### 2a. Metrics listener (`src/telemetry/metrics.server.ts`)

- Separate HTTP listener on `METRICS_PORT` (default 9464) — **not** the Express app on 3000
- Optional bearer auth per §3.5
- Started from `server.ts` alongside `app.listen()`, and closed in the existing graceful-shutdown sequence (`server.ts:50`)
- Must **not** be registered on the Express `app`, or it inherits the public listener

#### 2b. HTTP RED metrics

`src/middleware/request-logger.ts` is an **empty file**; the request logger currently lives inline at `app.ts:42-58`. Move it into the empty file and add metrics alongside the existing `res.on('finish')` hook, which already computes `latencyMs`.

##### ⚠️ The cardinality trap is right here

`app.ts:49` logs `req.path`. As a **metric label** that is fatal:

```ts
// ❌ req.path        → /payments/chk_a1b2c3d4...   unbounded, one series per payment
// ✅ req.route?.path → /payments/:chkId            bounded
```

Prometheus will degrade within a day if raw paths become labels.

##### ⚠️ Do not define the duration histogram — `HttpInstrumentation` already emits it

This is the trap that follows directly from "follow the semantic conventions": the
instrumentation **already** publishes a server-duration histogram.

| Mode | Instrument | Unit |
|---|---|---|
| default (old semconv) | `http.server.duration` | milliseconds |
| `OTEL_SEMCONV_STABILITY_OPT_IN=http` | `http.server.request.duration` | seconds |

Hand-defining `http.server.request.duration` from a second meter produces **two
metric families with the same name in one exposition, and Prometheus rejects the
whole scrape** — so the endpoint returns data that silently never lands.

**Resolution:**

1. Opt into stable semconv in `tracing.ts` (§5 Phase 0) so the seconds-based,
   correctly-named histogram is the one emitted. The app sets this itself; it is not
   something operators should have to configure.
2. **Do not create a duration instrument.** Use the instrumentation's.
3. Add `http.server.active_requests` **only** if the probe shows the instrumentation
   does not already emit it under stable semconv.
4. Apply the §2d buckets to it through a **View** — see below.

##### Label names come from semconv, not from the log fields

The attribute keys are dotted and fully spelled out. An earlier revision of this
section listed `{method, route, status_code}`, which are the *log* field names and
would have produced a metric no standard dashboard recognises:

| ❌ Not this | ✅ Semconv |
|---|---|
| `method` | `http.request.method` |
| `route` | `http.route` |
| `status_code` | `http.response.status_code` |

`http.route` is also the bounded value from the cardinality note above — the
instrumentation populates it from Express's route pattern, not from `req.path`.

#### 2c. Base units — never hand-write unit suffixes

The Prometheus exporter appends unit suffixes itself. Declare the instrument with a dotted name and a unit; let the exporter render the Prometheus name:

```ts
meter.createHistogram('gateway.request.duration', { unit: 's' })
// renders as: checkoutos_gateway_request_duration_seconds
```

**Rules:**

- Always base units: **seconds**, **bytes**. Never `_ms`, never `_kb`.
- Do not put the unit in the instrument name *and* set `unit` — you get `..._seconds_seconds`.
- Counters get `_total` appended automatically. Do not add it yourself.

A metric named `..._ms` will be silently misinterpreted by Datadog's unit mapping.

#### 2d. Explicit histogram buckets

OTel's default bucket boundaries are generic and wrong for this workload. **Bucket layout is baked into the exposition, so every downstream consumer inherits whatever is chosen here.** Define them once in `src/telemetry/buckets.ts`.

| Histogram | Boundaries (seconds) | Rationale |
|---|---|---|
| `gateway.request.duration` | `0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 8, 10, 15` | `REQUEST_TIMEOUT_MS` is 10s. The **8** boundary exists so the `GatewayLatencyP99High` alert (§10.2) can fire accurately. |
| `http.server.request.duration` | `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` | Standard web-tier spread |
| `webhook.processing.duration` | `0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5` | Mostly Redis-bound; sub-millisecond resolution matters |
| `webhook.relay.duration` | `0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 7.5` | `RELAY_TIMEOUT_MS` is 5s; boundaries past it capture timeout cases |

##### Two mechanisms, depending on who owns the instrument

The plan previously specified boundaries without saying how they are applied. They are
not interchangeable:

| Instrument | Mechanism | Where it lives |
|---|---|---|
| **Yours** (`gateway.request.duration`, `webhook.*`) | `advice: { explicitBucketBoundaries: […] }` at creation | `src/telemetry/metrics.ts` |
| **Not yours** (`http.server.request.duration`, from the instrumentation) | a **`View`** matching the instrument name | `src/telemetry/tracing.ts` — views attach to the provider |

```ts
// tracing.ts — the only way to set boundaries on an instrument you did not create
views: [
  new View({
    instrumentName: 'http.server.request.duration',
    aggregation: new ExplicitBucketHistogramAggregation(HTTP_SERVER_BUCKETS),
  }),
],

// metrics.ts — for instruments you do create
meter.createHistogram('gateway.request.duration', {
  unit: 's',
  advice: { explicitBucketBoundaries: GATEWAY_BUCKETS },
});
```

`buckets.ts` exports both arrays; `tracing.ts` imports it for the views and `metrics.ts`
imports it for the advice, so the numbers are still defined exactly once.

**Rule:** every alert threshold must coincide with a bucket boundary. An alert at p99 > 8s is meaningless if the buckets jump from 5 to 10.

#### 2e. `target_info` and resource attributes

OTel resource attributes (`service.name`, `service.version`, `deployment.environment`) are exposed as a separate `target_info` metric rather than as labels on every series. Consumers are expected to join on it.

- Prometheus/Grafana handle this natively
- Some vendors do not, and will appear to "lose" the `env` label
- Do **not** work around it by copying resource attributes onto every metric as labels — that multiplies cardinality across the whole catalogue

Document the join in `docs/metrics.md` (§7).

---

### Phase 3 — Domain metrics · ~2–3 days

The highest-value phase. See §6 for the full catalogue.

**Order note:** complete **Phase 4 (guardrails) before Phase 3.** Phase 3 is exactly where tempting-but-fatal labels live — putting `chkId` on a payment counter feels natural and is catastrophic. The rail must exist first.

---

### Phase 4 — Cardinality and PCI guardrails · ~1 day

See §8. Enforced in code, not documentation.

---

### Phase 5 — Dashboards and alerts as code · ~2 days

See §10.

---

### Phase 6 — Traces via Tempo (optional) · ~0.5 day

Once Phase 0 lands, traces are nearly free, and `trace_id` is what makes Loki → Tempo → Prometheus click-through work. Head sampling: 100% of errors, ~10% otherwise.

This is the phase that introduces OTLP into the codebase — which is what makes the opt-in metrics reader in §3.4 essentially free.

---

## 6. Metric catalogue

Namespace: `checkoutos_`. Every metric below is defined once in `src/telemetry/metrics.ts`.

Instrument names are given in OTel dotted form; the Prometheus rendering appends the namespace, unit and `_total` per §5 Phase 2c.

### 6.1 Gateway metrics — via decorator, not plugin edits

Rather than adding metrics inside `razorpay.plugin.ts` and `paytm.plugin.ts` (and then PayU, and Cashfree, and forgetting one), wrap at the registry:

```ts
// src/telemetry/gateway.decorator.ts
export function withTelemetry(plugin: GatewayPlugin): GatewayPlugin
```

Applied once at plugin instantiation — `gateway.registry.ts:162` and `:180`.

**Why this matters:** every future gateway is instrumented the day it is written, with no extra work and no possibility of omission. This preserves the existing architectural rule that *adding a gateway = registry entry + plugin file only*.

```
checkoutos_gateway_request_duration_seconds{gateway, operation, outcome}   histogram
checkoutos_gateway_requests_total{gateway, operation, outcome}             counter
```

`operation` ∈ `createPayment | getPaymentStatus | createRefund | getRefundStatus | healthCheck`
`outcome` ∈ `success | timeout | gateway_error | mapping_error`

#### The decorator wraps seven methods, and two of them are not async

`GatewayPlugin` (`gateway.types.ts:106-146`) is not uniformly `Promise`-returning. `withTelemetry` must handle three shapes, and getting this wrong turns a sync method into a promise and breaks every caller:

| Method | Signature | Decorator treatment |
|---|---|---|
| `createPayment`, `getPaymentStatus`, `createRefund`, `getRefundStatus`, `healthCheck` | `Promise<T>` | Duration histogram + outcome counter — the five in the `operation` enum |
| `parseWebhookEvent` | **sync** `WebhookEvent` | Wrap synchronously. **No `await`, no histogram.** Counter only. |
| `getCheckoutAction` | `Promise<CheckoutAction> \| CheckoutAction` | Union — must not be blanket-`await`ed. Leave undecorated; it does no network I/O. |

**This moves `webhook_signature_failures_total` into the decorator.** §6.3 and §6.6 currently attribute that counter to "plugin `parseWebhookEvent`", which would mean editing `razorpay.plugin.ts` and `paytm.plugin.ts` — exactly what §6.1 exists to avoid. Because `parseWebhookEvent` throws on an invalid signature, the sync wrapper catches it, increments, and rethrows. No plugin file is touched, and every future gateway gets the counter for free.

#### Implementation

```ts
// src/telemetry/gateway.decorator.ts

// Signature failures are classified by ErrorCode, NOT by error class — see below.
const SIGNATURE_FAILURE_CODES: ReadonlySet<string> = new Set([
  ErrorCode.GATEWAY_INVALID_SIGNATURE,   // razorpay
  ErrorCode.PAYTM_CHECKSUM_FAILED,       // paytm — different code, same meaning
]);

function classify(err: unknown): Outcome {
  if (!(err instanceof AppError)) return 'gateway_error';
  if (err.code === ErrorCode.GATEWAY_TIMEOUT) return 'timeout';
  if (err.code === ErrorCode.GATEWAY_MAPPING_ERROR) return 'mapping_error';
  return 'gateway_error';
}

export function withTelemetry(plugin: GatewayPlugin): GatewayPlugin {
  const g = plugin.name;

  const timed = <A extends unknown[], R>(
    op: GatewayOperation,
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      const t0 = process.hrtime.bigint();
      let outcome: Outcome = 'success';
      try {
        return await fn(...args);
      } catch (err) {
        outcome = classify(err);
        throw err;
      } finally {
        const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
        const labels = gatewayLabels(g, op, outcome);   // §8.2 — the only label source
        gatewayDuration.record(seconds, labels);
        gatewayRequests.add(1, labels);
      }
    };
  };

  return {
    name: plugin.name,

    createPayment:     timed('createPayment',    plugin.createPayment.bind(plugin)),
    getPaymentStatus:  timed('getPaymentStatus', plugin.getPaymentStatus.bind(plugin)),
    createRefund:      timed('createRefund',     plugin.createRefund.bind(plugin)),
    getRefundStatus:   timed('getRefundStatus',  plugin.getRefundStatus.bind(plugin)),
    healthCheck:       timed('healthCheck',      plugin.healthCheck.bind(plugin)),

    // SYNC — no await, no histogram. Counter only.
    parseWebhookEvent: (body, headers): WebhookEvent => {
      try {
        return plugin.parseWebhookEvent(body, headers);
      } catch (err) {
        if (err instanceof AppError && SIGNATURE_FAILURE_CODES.has(err.code)) {
          // webhookLabels(), not a raw literal — §8.2 applies to the telemetry
          // layer too, and this line is the one most likely to be copied.
          webhookSignatureFailures.add(1, webhookLabels(g));
        }
        throw err;
      }
    },

    // UNION return — no network I/O. Passed through untouched.
    getCheckoutAction: plugin.getCheckoutAction.bind(plugin),
  };
}
```

Applied at the registry:

```ts
// gateway.registry.ts:162 and :180
gatewayPlugins['razorpay'] = withTelemetry(createRazorpayPlugin(razorpayConfig));
gatewayPlugins['paytm']    = withTelemetry(createPaytmPlugin(paytmConfig));
```

##### Three details that will bite

**`.bind(plugin)` is mandatory.** Both plugins are class instances using `this.creds` and `this.http`. Passing an unbound method reference loses `this` and throws on the first call — after the decorator has already been merged and reviewed, because nothing in the type system catches it.

**Classify signature failures by `ErrorCode`, never by class.** Razorpay throws `GatewayInvalidSignatureError` (`GATEWAY_INVALID_SIGNATURE`); Paytm throws `PaytmChecksumFailedError` (`PAYTM_CHECKSUM_FAILED`) — a different class *and* a different code. An `instanceof GatewayInvalidSignatureError` check silently misses every Paytm forgery, which is precisely the attack signal §6.3 exists to catch. **Every new gateway must add its signature-failure code to `SIGNATURE_FAILURE_CODES`** — add this to the gateway checklist in AGENTS.md (§5 Phase 0), because it is the one thing the decorator cannot infer for itself.

**Every returned function needs an explicit return type.** `explicit-function-return-type` runs with `allowHigherOrderFunctions: false` (`eslint.config.js`), which is why `timed` annotates both its own return type and the inner `async` function. Expect this to be noisy; do not disable the rule for the file.

### 6.2 Payment lifecycle

```
checkoutos_payments_created_total{gateway, currency, status}
checkoutos_payment_transitions_total{gateway, from, to}
checkoutos_payment_transitions_blocked_total{gateway, from, to}
checkoutos_payments_awaiting_webhook                              gauge — see below
checkoutos_gateway_poll_success_suppressed_total{gateway}
```

> **`payments_awaiting_webhook` must not be an in-process `UpDownCounter`.** The state
> it reports lives in Redis, so a counter held in the process resets to zero on every
> restart and disagrees across replicas — it would read as "the problem resolved itself"
> at exactly the moment a deploy happened.
>
> **Ship the alert first, the gauge later.** `rate(checkoutos_gateway_poll_success_suppressed_total[30m]) > 0`
> catches the same condition, needs no new state, and can land with Phase 3.
>
> When the gauge does arrive it must be an **`ObservableGauge`** over an O(1) Redis
> read — `SCARD` on a set the payment store maintains — with a 100 ms timeout, a ~10 s
> cache, and a `catch` that reports the last known value. A scrape must never be able
> to throw into Redis or block on it: §3.2.1 applies to the pull path too.

### 6.3 Webhooks

```
checkoutos_webhook_received_total{gateway, event, result}
checkoutos_webhook_signature_failures_total{gateway}      ← emitted by the decorator, §6.1
checkoutos_webhook_unknown_payment_total{gateway}
checkoutos_webhook_processing_duration_seconds{gateway}
checkoutos_webhook_relay_attempts_total{outcome}
checkoutos_webhook_relay_duration_seconds
```

> **"Fire-and-forget" describes the failure handling, not the scheduling.** `webhook.service.ts:214` is `await relayWebhook(chkId, event)` — the relay is *awaited*; it is `relayWebhook`'s internal `catch` that swallows the error (`:246`). So relay latency sits **on the webhook response path**: a merchant endpoint that hangs adds up to `RELAY_TIMEOUT_MS` (5 s) to the time checkoutOs takes to answer the *gateway*.
>
> Two consequences for this catalogue:
> - `webhook_relay_duration_seconds` and `webhook_processing_duration_seconds` overlap. Record `processing` around the state-machine work **before** the relay call, so the two are separable rather than nested. Otherwise every processing histogram carries the merchant's latency and the Redis-bound sub-millisecond buckets in §5 Phase 2d are pointless.
> - A slow merchant can push webhook handling past the gateway's own retry window. That is worth an alert once the data exists, and it is invisible today — the relay histogram is what makes it visible.

### 6.4 Idempotency and dedup

```
checkoutos_idempotency_decisions_total{result}
checkoutos_orderid_reservation_conflicts_total
```

`result` ∈ `miss | hit | in_progress | stale_recovered | hash_mismatch` — maps 1:1 onto the existing structured log events in `idempotency.service.ts`.

### 6.5 Refunds

```
checkoutos_refunds_total{gateway, outcome}
checkoutos_refund_amount_minor_total{gateway, currency}
```

> Named `_minor` (minor currency unit) with an explicit `currency` label rather than
> `_paise`. Only INR is supported today, so the two are identical in practice — but
> `payments_created_total` already carries `currency`, and under §7.2 renaming a metric
> or adding a label later is a **Major** change with a deprecation cycle. This one costs
> nothing to get right now and is expensive to fix afterwards.

### 6.6 Which blind spot each metric closes

| Metric | Blind spot | Source |
|---|---|---|
| `webhook_relay_attempts_total` | Fire-and-forget relay: merchant down = silent data loss | `webhook.service.ts:246` |
| `webhook_signature_failures_total` | Forged webhooks — a spike is an attack signature | `gateway.decorator.ts` wrapping `parseWebhookEvent` (§6.1) |
| `webhook_unknown_payment_total` | The `no_chk_id_found` path — orphans and lookup bugs | `webhook.service.ts:143` |
| `payment_transitions_blocked_total` | **Would immediately surface the `refund.processed` bug** — a steady stream of blocked `SUCCESS→REFUNDED` | `webhook.service.ts:180` |
| `payments_awaiting_webhook` | Unrefundable money accumulating | `payments.service.ts:320` |
| `idempotency_decisions_total` | Retry storms; whether dedup actually fires | `idempotency.service.ts` |
| `orderid_reservation_conflicts_total` | Proves the orderId race fix works | pending fix |

### 6.7 Service level indicators

Generic RED is insufficient for a payment orchestrator. The signals that matter:

- **Payment creation success rate, per gateway** — gateway health; failover trigger
- **Gateway latency p99** — `REQUEST_TIMEOUT_MS` is 10s; that is the budget
- **Webhook processing lag** — gateway event timestamp → our status write. Tells you money is being confirmed late.
- **Refund success rate**
- **Idempotency hit rate** — a sudden rise means clients are retrying, i.e. something upstream is broken

---

## 7. The metric contract — `/metrics` is a public API

This section exists because of §3.2. Once the endpoint is the documented integration surface for an open-core project, **metric names, label sets, and bucket boundaries become a public contract.** Renaming `checkoutos_payments_created_total` silently empties every user's dashboards and disables their alert rules.

### 7.1 Publish the catalogue separately

§6 is an implementation plan and will go stale. Extract the catalogue into **`docs/metrics.md`** — a user-facing reference listing every metric, its type, unit, labels, allowed label values, and bucket boundaries. OSS users must be able to read it without reading this plan.

### 7.2 Stability policy

| Change | Allowed in |
|---|---|
| Adding a new metric | Any release |
| Adding a new **label value** to an existing closed set | Minor |
| Adding a new **label** to an existing metric | **Major** — it changes series identity and breaks existing aggregations |
| Renaming a metric | **Major**, and only with a deprecation cycle |
| Removing a metric | **Major**, and only after one minor cycle marked deprecated |
| Changing bucket boundaries | **Major** — silently changes every histogram quantile |
| Changing a unit | **Major** — never do this; pick base units once (§5 Phase 2c) |

**Deprecation cycle:** emit both the old and new names for one full minor version, mark the old one deprecated in `docs/metrics.md`, and note it in the changelog. Then remove.

### 7.3 Enforce the contract with an exposition snapshot

A stability policy nothing checks is a policy that gets broken by accident. Because §3.2 makes `/metrics` the integration surface, its *shape* can be snapshotted and diffed in CI.

`scripts/verify-telemetry.mjs` (§5 Phase 0) already scrapes a live exposition. Have it write the **shape** — not the values — to `observability/exposition.snapshot.txt`:

- every `# TYPE` and `# HELP` line
- the label **keys** on each series (never the values — `gateway="razorpay"` is data, `gateway` is contract)
- the `le` boundaries of every histogram

Sample values change on every run and must be stripped, or the snapshot is noise.

CI fails on an undiffed change. The effect is that renaming a metric, adding a label, or nudging a bucket boundary becomes a deliberate commit that shows the break in review — which is exactly what §7.2 asks for and previously left to discipline. It also catches the `prefix` regression: drop `prefix: 'checkoutos'` from §3.4 and every name in the snapshot changes at once.

### 7.4 Cardinality is part of the contract

Adding a label to an existing metric is as breaking as a rename — every `sum by (...)` in every user dashboard changes meaning. Treat label sets as frozen once released. This is the operational reason the guardrails in §8 are enforced in code rather than by review.

---

## 8. Cardinality and PCI guardrails

checkoutOs is a payments system. The rules differ **per signal type**, and conflating them is the most common way to destroy a metrics backend.

| Field | Metric labels | Loki **labels** | Loki log **body** | Span attributes |
|---|---|---|---|---|
| `gateway`, `status`, `event`, `outcome` | ✅ | ✅ | ✅ | ✅ |
| `chkId`, `orderId`, `gatewayPaymentId`, `refId` | ❌ never | ❌ never | ✅ | ✅ |
| `customerEmail`, `customerPhone`, `customerName` | ❌ | ❌ | ❌ | ❌ |
| Card data / any PAN | ❌ | ❌ | ❌ | ❌ |

### 8.1 Two traps worth naming explicitly

**Loki labels are not log fields.** Putting `chkId` in a Loki *label* creates one stream per payment and will exhaust Loki faster than it exhausts Prometheus. It belongs in the log *line*, where it remains fully searchable.

**`WebhookEvent.raw` contains the entire gateway payload.** (`gateway.types.ts:76` — `raw: unknown; // original payload`.) If it reaches Loki, the log store is arguably pulled into PCI scope. Related: `razorpay.plugin.ts:99-105` and `:218-225` currently dump complete API request/response bodies to `console`. A redaction step is required before anything containing `raw` is logged.

> **Out of scope for this plan, but found while writing it:** `webhook.service.ts:225-226` builds the relay payload as `{ paymentId: chkId, ...event }` — the spread includes `raw`, so **the full gateway payload is already forwarded to `WEBHOOK_RELAY_URL` today**, before any of this instrumentation exists. That is a data-handling decision, not an observability one, and it should be raised separately. It is noted here because the redaction helper this phase builds is the same helper that would fix it — build it as a standalone pure function in `src/utils/`, taking `WebhookEvent` and returning a safe projection, so both call sites can use it. (A pure redaction function is legitimately a util; the *emission* is what §4 keeps out of `src/utils/`.)

### 8.2 Enforce in code, not in a wiki

`src/telemetry/attributes.ts` exports the **only** permitted label builders, each accepting a closed set:

```ts
export function gatewayLabels(
  gateway: GatewayName,
  operation: GatewayOperation,
  outcome: Outcome,
): Attributes;

export function webhookLabels(gateway: GatewayName): Attributes;
export function httpLabels(method: string, route: string, status: number): Attributes;
```

**The telemetry layer is not exempt from its own rule.** The obvious slip is
`webhookSignatureFailures.add(1, { gateway })` inside `gateway.decorator.ts` — a raw
literal in the very file contributors will copy from. That is why `webhookLabels()`
exists as a one-argument builder.

The lint rule needs scoping, or it fires on `Set.prototype.add`:

```js
{
  files: ['src/services/**/*.ts', 'src/middleware/**/*.ts', 'src/telemetry/**/*.ts'],
  rules: {
    'no-restricted-syntax': ['error', {
      selector: "CallExpression[callee.property.name=/^(add|record|observe)$/] > ObjectExpression",
      message: 'Metric attributes must come from src/telemetry/attributes.ts — see ADR 003 §8.2',
    }],
  },
}
```

Matching on `ObjectExpression` as an argument (rather than any `.add()` call) keeps
`someSet.add(x)` and `map.set()` clear of it.

*Rationale:* cardinality bugs are nearly impossible to catch in code review and catastrophic in production. Make them a lint error at minimum, and a type error where the builder signature allows.

---

## 9. Scrape configuration — proving vendor neutrality

One endpoint, four consumers, no application change. These configurations exist so the neutrality claim in §3.3 is verifiable rather than asserted, and should be kept in the repository under `observability/examples/`.

**Prometheus**

```yaml
scrape_configs:
  - job_name: checkoutos
    scrape_interval: 15s
    static_configs:
      - targets: ['checkoutos:9464']
    # authorization:            # only if METRICS_AUTH_TOKEN is set (§3.5)
    #   credentials: <token>
```

**Grafana Alloy**

```
prometheus.scrape "checkoutos" {
  targets    = [{ __address__ = "checkoutos:9464" }]
  forward_to = [prometheus.remote_write.default.receiver]
}
```

**Datadog Agent** (`openmetrics` check — no Prometheus required anywhere)

```yaml
instances:
  - openmetrics_endpoint: http://checkoutos:9464/metrics
    namespace: checkoutos
    metrics:
      - checkoutos_*
```

**OpenTelemetry Collector** (`prometheusreceiver`, for pipelines that want OTLP downstream)

```yaml
receivers:
  prometheus:
    config:
      scrape_configs:
        - job_name: checkoutos
          static_configs:
            - targets: ['checkoutos:9464']
```

Note the last one: even an OTLP-centric pipeline can consume the pull endpoint. Push is genuinely optional.

---

## 10. Dashboards and alerts as code

Provisioned from the repository so an OSS user gets value on first `docker compose up`.

```
observability/
  docker-compose.observability.yml     # profile: observability
  prometheus/prometheus.yml
  loki/loki-config.yml
  alloy/config.alloy
  examples/                            # §9 — Datadog, OTel Collector, Alloy
  grafana/provisioning/{datasources,dashboards}/
  grafana/dashboards/
    checkoutos-overview.json           # RED + payment funnel
    checkoutos-gateways.json           # per-gateway latency/errors — the failover view
    checkoutos-webhooks.json           # delivery, signature failures, relay health
    checkoutos-idempotency.json        # hit rate, races, stale recoveries
```

### 10.1 Tiered profiles — do not ship one all-or-nothing bundle

The full stack is **seven containers** for someone evaluating a payment orchestrator:

```
checkoutOs + Redis            (2, already required)
+ Prometheus, Loki, Tempo     (3 stateful stores — 3 retention policies, 3 disk-growth surprises)
+ Alloy, Grafana              (2)
```

Three storage systems also means three independent ways the observability stack can break without the application being at fault. Tier the profiles so the first dashboard costs the least commitment, consistent with the adoption-friction reasoning in §3.2.3:

```bash
docker compose --profile metrics        # Prometheus + Grafana            (2 containers)
docker compose --profile observability  # + Loki + Alloy                  (4 containers)
docker compose --profile tracing        # + Tempo                         (5 containers)
```

Each profile is a superset of the previous one. `metrics` is the recommended entry point in the README: it exercises the pull endpoint from §3.2 and produces working dashboards with no log or trace pipeline at all.

Mirrors the existing `--profile mock` convention.

#### Note on stdout collection

The `stdout JSON → Alloy` path inherits the container runtime's log handling. Docker's `json-file` driver can drop lines during rotation under high volume — set `max-size`/`max-file` deliberately for Compose deployments. Kubernetes node-level collection does not have this issue.

#### Optional simplification: one agent instead of two

The diagram in §3 runs two collection agents — Prometheus scraping `/metrics` and Alloy tailing logs. Alloy can do **both** (and receive OTLP traces), collapsing to a single agent that `remote_write`s to Prometheus. This is the cleaner path if enterprise users later forward to Grafana Cloud (§2.2). The scrape configuration is in §9. Either topology is supported; two agents is the simpler default to explain.

> ⚠️ `docker-compose.yml:46` references `Dockerfile.mock`, which does not exist in the repository — the `mock` profile is already broken. Do not copy that pattern. Verify the observability profile starts from a clean clone before merging.

### 10.2 Starter alert rules

| Alert | Condition | Why |
|---|---|---|
| `WebhookRelayFailing` | relay failure rate > 5% for 10m | Merchants silently not receiving events |
| `GatewaySignatureFailures` | any sustained non-zero rate | Possible forgery attempt |
| `PaymentsAwaitingWebhook` | `rate(gateway_poll_success_suppressed_total[30m]) > 0` — switch to the gauge once §6.2's Redis-backed `ObservableGauge` lands | Unrefundable money accumulating |
| `TransitionsBlockedSpike` | blocked transitions > 0 sustained | The `refund.processed` bug, live |
| `GatewayLatencyP99High` | p99 > 8s (80% of the 10s timeout) | Approaching timeout cliff — **requires the 8s bucket boundary, §5 Phase 2d** |
| `PaymentCreationFailureRate` | > 2% for 5m, per gateway | Gateway degradation |
| `MetricsEndpointDown` | `up{job="checkoutos"} == 0` | Free liveness signal from pull (§3.2.3) |

---

## 11. Sequencing

| Phase | Effort | Unblocks |
|---|---|---|
| **0-pre — module format + circular dependency** | **0.5 day** | **Everything, including `npm start` and the production image. Not optional and not observability work — see §5 Phase 0 Prerequisites.** |
| 0 — `src/telemetry/` skeleton + ESM hook + verify script | 1.5 days | Everything. Budget for the ESM trap **and** the OTel API/exporter-default probe (§5 Phase 0). |
| 1a — Logger reshape + 75-call-site event rename | **1.5–2 days, own commit** | Everything downstream of structured logs |
| 1b — Debug-noise removal + Alloy → Loki | 1 day | Trace-correlated logs in Loki |
| 2 — `/metrics` on :9464 + HTTP RED + buckets/units | 1.5 days | First dashboard |
| 4 — Cardinality guardrails + redaction | 1 day | Safe to add domain labels |
| 3 — Gateway decorator + domain metrics | 2–3 days | **The audit blind spots** |
| 5 — Dashboards + alerts as code | 2 days | OSS user value on first run |
| 6 — Tempo | 0.5 day | Full signal correlation |

**Ordering: 0-pre → 0 → 1a → 1b → 2 → 4 → 3 → 5 → 6.** Guardrails (4) precede domain metrics (3) deliberately — see §5 Phase 3.

**0-pre is a hard gate.** `npm start` and `Dockerfile:69` do not run today (§5 Phase 0 Prerequisites). Phase 0's production bootstrap line targets the compiled output, so no amount of telemetry code can be validated until the compiled output executes. Ship 0-pre on its own even if the rest of this plan is deferred indefinitely — it is a broken production image, not a prerequisite for dashboards.

**Phase 1 is split because 1a is the schedule risk in this plan.** It touches 75 call sites in 15+ files, changes an exported module surface that **both** `vitest.setup.unit.ts` and `vitest.setup.integration.ts` hand-mock, and conflicts textually with any branch that logs anything — which is every branch. It is not technically hard; it is hard to *merge*. Land it alone, early, on a quiet tree. Everything else here is additive and rebases cleanly.

If the team wants a visible win before committing to 1a: **Phase 0 → Phase 2 produces a working `/metrics` endpoint and an HTTP RED dashboard without touching a single existing log line.** That is a legitimate reordering and it de-risks the log migration by proving the pipeline first. The cost is that Loki lands later, and `trace_id` grouping (§3.6) arrives with it.

---

## 12. Open questions

- **Per-merchant labels.** Multi-tenancy is deferred to V1.2. When `merchantId` arrives it must **not** become a metric label without a bounded merchant count — revisit §8, and note that adding it is a breaking change under §7.2.
- **Exemplars.** Linking Prometheus histogram buckets to trace IDs requires `--enable-feature=exemplar-storage` plus OpenMetrics exposition. This is the missing edge of the correlation triangle — see §3.6. Defer to Phase 6.
- **Metrics during the PostgreSQL migration.** `IORedisInstrumentation` gives store spans for free today; the equivalent for `pg` is `PgInstrumentation`. Swap in the same place.
- **Log retention policy.** Not decided. Must be set before production given §8.1 PCI considerations.
- **Native histograms.** Prometheus native histograms would remove the fixed-bucket problem in §5 Phase 2d, but support across the consumers in §9 is uneven. Revisit once Datadog and Alloy support is stable.

---

## 13. Related

- `docs/metrics.md` — the user-facing metric contract (§7.1, to be extracted)
- `docs/adr/001-idempotency.md` — the event names in §6.4 map 1:1 onto its log events
- `docs/adr/002-paytm-integration.md` — plugin contract this instrumentation decorates
- `AGENTS.md` §Architecture Rules — layer boundaries respected in §4; **updated by Phase 0**
- `src/telemetry/` — implementation (Phase 0)
- OpenTelemetry semantic conventions — HTTP metric naming in §5 Phase 2b

---

## 14. Verification log — 2026-09-15

Every file and line reference in this plan was checked against the working tree at `a7f18a3`. Recorded here so a future reader knows which claims are load-bearing and which have drifted.

### Confirmed accurate

| Claim | Location | Status |
|---|---|---|
| `request-logger.ts` is an empty file | `src/middleware/request-logger.ts` | ✅ 0 bytes |
| Request logger lives inline in `buildApp()` | `app.ts:42-58` | ✅ exact |
| `req.path` is logged (the cardinality trap) | `app.ts:49` | ✅ exact |
| Plugin instantiation sites for the decorator | `gateway.registry.ts:162`, `:180` | ✅ exact |
| `ENV DEBUG` console.log on every boot | `server.ts:24-28` | ✅ exact |
| `log.debug('Sumit debug', …)` | `health.service.ts:36` | ✅ exact |
| Razorpay API-error body dump | `razorpay.plugin.ts:99-105` | ✅ exact |
| Graceful-shutdown hook for closing the metrics listener | `server.ts:50` (`shutdown()`) | ✅ exact |
| Relay failure logs a warning and returns | `webhook.service.ts:246` | ✅ exact |
| Blocked transition warning | `webhook.service.ts:180-181` | ✅ exact |
| `no_chk_id_found` path | `webhook.service.ts:143-147` | ✅ exact |
| Poll-detected SUCCESS suppressed | `payments.service.ts:320-321` | ✅ exact |
| `parseWebhookEvent` is **sync** (blocks the edge port) | `gateway.types.ts:128-131` | ✅ exact |
| `node:crypto` usage blocking edge | `razorpay.plugin.ts:4, 294-295, 302` | ✅ exact |
| `REQUEST_TIMEOUT_MS` = 10 s (both plugins) | `razorpay.plugin.ts:44`, `paytm.plugin.ts:54` | ✅ — the 8 s bucket boundary is correct |
| `RELAY_TIMEOUT_MS` = 5 s | `webhook.service.ts:35` | ✅ — the 7.5 s boundary is correct |
| `mock` profile is broken | `docker-compose.yml:46` references `Dockerfile.mock`, absent | ✅ (plan said `:44`; that is the `build:` key, dockerfile key is `:46`) |
| Store boundary is clean → `IORedisInstrumentation` is a free win | only `src/store/*` imports `redisClient` | ✅ confirmed |

### Corrected in this revision

| Original claim | Reality | Fixed in |
|---|---|---|
| "~53 distinct log messages" | **75 call sites, ~73 distinct**; 15 already dotted | §5 Phase 1a |
| `log.info({ event: …, … })` target shape | Does not typecheck — `ContextLogger` is `(message: string, meta?)` | §5 Phase 1a |
| Logger fix is a mechanical migration | Also changes a module surface that **both** vitest setups hand-mock — `vitest.setup.unit.ts:36-49` and `vitest.setup.integration.ts`. Resolution: delete both mocks; `silent: config.isTest` already covers it | §5 Phase 1a |
| `ContextLogger` must change to carry `event` | It must not — `(event: string, fields?)` is structurally identical to `(message: string, meta?)`, so all 75 call sites compile untouched | §5 Phase 1a |
| `pkg.version` for `service.version` | `import pkg from '../package.json'` does not compile — `rootDir: "src"` excludes it and `resolveJsonModule` is off. Use `APP_VERSION` | §5 Phase 0, §3.5 |
| Signature failures identifiable by error class | Razorpay throws `GATEWAY_INVALID_SIGNATURE`, Paytm throws `PAYTM_CHECKSUM_FAILED` — classify by `ErrorCode`, or every Paytm forgery goes uncounted | §6.1 |
| Span acceptance test fits an existing project | Neither works: `unit` mocks `ioredis`, `integration` sets `NODE_ENV=test` which disarms the SDK. Needs a third vitest project | §5 Phase 0 |
| `new MeterProvider({ readers })` in `metrics.ts` | Conflicts with `NodeSDK`'s own global provider — silent empty `/metrics` | §3.4 |
| `new Resource(…)` / `SEMRESATTRS_*` | Pre-2.0 OTel JS API | §5 Phase 0 |
| Signature-failure counter lives in the plugins | Belongs in the decorator — plugins stay untouched | §6.1 |
| Debug noise = 3 sites | Also `razorpay.plugin.ts:218-225, 235` and `bootstrap.ts:9, 11` | §5 Phase 1b |
| Relay is fire-and-forget | It is **awaited** (`webhook.service.ts:214`); only the error is swallowed | §6.3 |
| "Telemetry disabled in tests" | `IORedisInstrumentation` vs `vi.mock('ioredis')` is a real collision | §5 Phase 0 |

### Now specified in this plan

Pre-existing defects found during verification that the phases above now fix:

- **`logger.ts:35` sets `level: 'silent'`**, which is not a winston npm level. Inert today only because the transport sets `silent: config.isTest` separately. → §5 Phase 1a, item 4.
- **`config.metrics` and `config.app.version` do not exist yet.** → §3.5 env var table.
- **`npm test` is still the `exit 1` placeholder.** CI must name `test:unit`, `test:integration` and the new `test:telemetry` explicitly. → §5 Phase 0.

### Third review round — reproduced, then fixed

| Finding | Evidence | Fixed in |
|---|---|---|
| **`npm start` cannot run** | Built and executed: `ReferenceError: exports is not defined in ES module scope`. `"type": "module"` + `"module": "CommonJS"`. Production image (`Dockerfile:69`) is affected | §5 Phase 0 Prereq — Blocker A |
| **Circular dependency, CJS-only** | `madge --circular` → `config/index.ts → env.schema.ts → gateway.registry.ts → paytm.plugin.ts → utils/logger.ts`. Surfaces as `z.enum(undefined)` throwing once Blocker A is fixed | §5 Phase 0 Prereq — Blocker B |
| Port 9464 bound twice | `PrometheusExporter` starts its own server; §3.5's listener wants the same port → `EADDRINUSE`, and the built-in server has no auth hook | §3.4 `preventServerStart` + §3.5 |
| Boot assertion could not detect its own bug | `target_info` renders from the reader's resource, so it appears under the wrong provider too; also 401s when a token is set | §3.4 — `build.info` sentinel |
| Default OTLP trace export + Winston log forwarding | `NodeSDK` with no trace config falls back to `OTEL_TRACES_EXPORTER` (OTLP, `localhost:4318`); `WinstonInstrumentation` sends records unless disabled. Both contradict §2.3 | §5 Phase 0 — no-op processor, `disableLogSending` |
| Span acceptance test proved nothing | A hand-built `NodeTracerProvider` never loads `tracing.ts`, `register.mjs`, or the real entry points | §5 Phase 0 — `verify-telemetry.mjs` |
| Duplicate HTTP histogram | `instrumentation-http` already emits server duration; a second instrument of the same name makes Prometheus reject the scrape. Listed labels were log fields, not semconv | §5 Phase 2b |
| Bucket application unspecified | Views for instruments you don't own; `advice` for those you do | §5 Phase 2d |
| Logger spread order | `webhook.service.ts:84, 145, 186, 199, 209` all pass `event: event.event` — every one would overwrite the dotted name | §5 Phase 1a |
| Lint rule rejected correct events | `[^a-z0-9.]` fails 16 of the 19 existing dotted events; three more use `orderId.*` not `orderid.*` | §5 Phase 1a |
| Decorator violated §8.2 | `add(1, { gateway: g })` is the raw literal §8.2 bans | §6.1, §8.2 |
| `LOG_FORMAT` exception rested on a false premise | `config/index.ts` never imports the logger; the dependency runs the other way | §3.5 |
| `prefix` never set | Without it, names render without `checkoutos_`, contradicting §6 | §3.4 |
| `payments_awaiting_webhook` had no design | In-process counter would reset on deploy and disagree across replicas | §6.2 |
| Dependency list vs bootstrap | Listed `auto-instrumentations-node` while constructing members individually | §5 Phase 0 |
| `refund_amount_paise_total` | Bakes in a currency while `payments_created_total` carries a `currency` label | §6.5 |

**Assessed and rejected:** a concern that `getCheckoutAction` might be optional, making `.bind` throw. `gateway.types.ts:106-146` declares all seven methods required — no `?` on any of them — so `.bind` is safe as written.

### Found while verifying — raised, not fixed here

- **`webhook.service.ts:225-226` relays `raw` to the merchant.** `{ paymentId: chkId, ...event }` spreads the full gateway payload to `WEBHOOK_RELAY_URL`. Pre-existing; adjacent to §8.1; needs its own decision. AGENTS.md states *"Relay payload uses `chk_` IDs — raw gateway IDs are never forwarded"*, which is true of the IDs and not of `raw`. The redaction helper built in Phase 4 is the same helper that would fix it.

---

## 15. Implementation checklist

Every code block in this plan is a specification, not an illustration. In dependency order.

**Phase 0-pre — the gate. Ship this even if nothing else here does.**
- [ ] `dist/package.json` commonjs stamp in the `build` script
- [ ] Prove it: `npm run build && node dist/server.js` reaches "server started"
- [ ] `src/config/runtime.ts` (no imports); `logger.ts` reads `runtime`, not `config`
- [ ] Prove it: `npx madge --extensions ts --circular src/server.ts` reports 0 cycles
- [ ] `import/no-restricted-paths` — `logger.ts` and `src/telemetry/**` may not import `config/index.ts`

**Phase 0**
- [ ] `npm i -E` the individual OTel packages (not `auto-instrumentations-node`)
- [ ] Probe: resource/semconv API surface **and** `OTEL_*_EXPORTER` defaults; record both here
- [ ] Decide provider ownership from `metricReaders` vs `metricReader` (§3.4); comment the choice in `tracing.ts`
- [ ] `APP_VERSION`, `LOG_FORMAT`, `METRICS_PORT`, `METRICS_AUTH_TOKEN` → `env.schema.ts` + `runtime.ts` + `.env.example` + Docker build arg
- [ ] `tracing.ts`: semconv opt-in, `NoopSpanProcessor`, `disableLogSending: true`, `if (!runtime.isTest) sdk.start()`, require-cache guard
- [ ] `readers.ts`: `preventServerStart: true`, `prefix: 'checkoutos'`
- [ ] `build.info` sentinel + boot assertion on `checkoutos_build_info` (with bearer header)
- [ ] `scripts/verify-telemetry.mjs` against **both** `npm start` and `npm run dev`; wire into CI
- [ ] `AGENTS.md`: telemetry layer, import restrictions, exporter isolation, *never instrument inside a plugin*, `SIGNATURE_FAILURE_CODES` in the gateway checklist

**Phase 1a — own commit, quiet tree**
- [ ] `logger.ts` rewrite (§5 Phase 1a) — signature unchanged, fields spread **first**
- [ ] `prodFormat` + `serializeErrors` for nested `Error` / `AppError`
- [ ] Delete `vi.mock('./src/utils/logger', …)` from **both** vitest setups
- [ ] `scripts/event-map.json` + codemod; rename the three `orderId.*` events; rename the five `event:` keys to `gatewayEvent`
- [ ] `app.ts:49` → `http.request.completed` with `req.route?.path`
- [ ] Lint rule for dotted events — **validate the selector against a fixture of all 19 existing events**

**Phase 2**
- [ ] `metrics.server.ts` with timing-safe bearer check; close it in `server.ts:50`
- [ ] Do **not** define a duration histogram — use the instrumentation's
- [ ] Buckets: `View` for `http.server.request.duration`, `advice` for your own
- [ ] Exposition snapshot written by the verify script; CI fails on an undiffed change (§7.3)

**Phases 4 · 3 · 5 · 6** — per §11, additive and rebase-safe.
