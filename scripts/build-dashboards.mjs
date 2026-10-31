// scripts/build-dashboards.mjs
// Generates the Grafana dashboards in observability/grafana/dashboards/
// (ADR 003 §10). The PromQL lives HERE, readable in review; the JSON is output.
//
//   node scripts/build-dashboards.mjs            # (re)write the JSON
//   node scripts/build-dashboards.mjs --check    # fail if the JSON is stale (CI)
//   node scripts/build-dashboards.mjs --promql-rules <file>
//       # also write every panel query as a recording rule, so CI can
//       # syntax-check them with `promtool check rules` without a running stack
//
// Conventions:
//   - Metric names and labels: docs/metrics.md. tests/unit/observability/
//     alerts.test.ts fails on an undocumented metric.
//   - Latency threshold lines sit on bucket boundaries (same test).
//   - Rates use $__rate_interval; every per-gateway panel honours $gateway.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'observability/grafana/dashboards';
const CHECK = process.argv.includes('--check');
const RULES_ARG = process.argv.indexOf('--promql-rules');
const RULES_OUT = RULES_ARG === -1 ? undefined : process.argv[RULES_ARG + 1];

const DS = { type: 'prometheus', uid: 'prometheus' };
const G = 'gateway=~"$gateway"';

// ── Panel builders ──────────────────────────────────────────────────────────

let nextId = 1;
let cursor = { x: 0, y: 0, rowHeight: 0 };

function place(w, h) {
  if (cursor.x + w > 24) cursor = { x: 0, y: cursor.y + cursor.rowHeight, rowHeight: 0 };
  const pos = { x: cursor.x, y: cursor.y, w, h };
  cursor.x += w;
  cursor.rowHeight = Math.max(cursor.rowHeight, h);
  return pos;
}

function targets(queries) {
  return queries.map(([expr, legendFormat], i) => ({
    datasource: DS,
    expr,
    legendFormat: legendFormat ?? '__auto',
    refId: String.fromCharCode(65 + i),
  }));
}

function thresholds(lines, mode = 'absolute') {
  return {
    mode,
    steps: [
      { color: 'green', value: null },
      ...lines.map((value, i) => ({ color: i === lines.length - 1 ? 'red' : 'orange', value })),
    ],
  };
}

function row(title) {
  if (cursor.x !== 0) cursor = { x: 0, y: cursor.y + cursor.rowHeight, rowHeight: 0 };
  const panel = {
    id: nextId++,
    type: 'row',
    title,
    collapsed: false,
    gridPos: { x: 0, y: cursor.y, w: 24, h: 1 },
    panels: [],
  };
  cursor = { x: 0, y: cursor.y + 1, rowHeight: 0 };
  return panel;
}

function stat(title, expr, { unit = 'short', w = 6, h = 4, lines, description } = {}) {
  return {
    id: nextId++,
    type: 'stat',
    title,
    ...(description && { description }),
    datasource: DS,
    gridPos: place(w, h),
    targets: targets([[expr, title]]),
    options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'value', graphMode: 'area' },
    fieldConfig: {
      defaults: {
        unit,
        ...(lines && { thresholds: thresholds(lines) }),
        color: { mode: lines ? 'thresholds' : 'fixed', fixedColor: 'blue' },
      },
      overrides: [],
    },
  };
}

function timeseries(
  title,
  queries,
  { unit = 'short', w = 12, h = 8, lines, stack = false, description } = {},
) {
  return {
    id: nextId++,
    type: 'timeseries',
    title,
    ...(description && { description }),
    datasource: DS,
    gridPos: place(w, h),
    targets: targets(queries),
    options: {
      legend: { displayMode: 'table', placement: 'bottom', calcs: ['mean', 'max', 'lastNotNull'] },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
    fieldConfig: {
      defaults: {
        unit,
        custom: {
          fillOpacity: stack ? 30 : 10,
          stacking: { mode: stack ? 'normal' : 'none' },
          ...(lines && { thresholdsStyle: { mode: 'line+area' } }),
        },
        ...(lines && { thresholds: thresholds(lines) }),
      },
      overrides: [],
    },
  };
}

const rate = (series, by, filter = '') =>
  `sum by (${by}) (rate(${series}${filter ? `{${filter}}` : ''}[$__rate_interval]))`;

const quantile = (q, metric, by, filter = '') =>
  `histogram_quantile(${q}, sum by (le${by ? `, ${by}` : ''}) (rate(${metric}_bucket${filter ? `{${filter}}` : ''}[$__rate_interval])))`;

// ratio of two rates, NaN-safe display (Grafana shows no value for 0/0)
const ratio = (num, den) => `(${num}) / (${den})`;

function dashboard({ uid, title, description, tags, variables = [], build }) {
  nextId = 1;
  cursor = { x: 0, y: 0, rowHeight: 0 };
  return {
    uid,
    title,
    description,
    tags: ['checkoutos', ...tags],
    editable: false,
    schemaVersion: 39,
    version: 1,
    time: { from: 'now-6h', to: 'now' },
    refresh: '30s',
    timezone: 'browser',
    graphTooltip: 1,
    links: [
      {
        type: 'dashboards',
        tags: ['checkoutos'],
        asDropdown: true,
        title: 'checkoutOs',
        includeVars: true,
        keepTime: true,
      },
      {
        type: 'link',
        title: 'Metric reference (docs/metrics.md)',
        url: 'https://github.com/checkoutOs/checkoutOs/blob/main/docs/metrics.md',
        targetBlank: true,
      },
    ],
    annotations: { list: [] },
    templating: { list: variables },
    panels: build(),
  };
}

const gatewayVariable = {
  name: 'gateway',
  label: 'Gateway',
  type: 'query',
  datasource: DS,
  query: { query: 'label_values(checkoutos_gateway_requests_total, gateway)', refId: 'gateway' },
  definition: 'label_values(checkoutos_gateway_requests_total, gateway)',
  includeAll: true,
  multi: true,
  allValue: '.*',
  current: { selected: true, text: ['All'], value: ['$__all'] },
  refresh: 2,
  sort: 1,
};

// ── Dashboards ──────────────────────────────────────────────────────────────

const HTTP = 'checkoutos_http_server_request_duration';
const GW = 'checkoutos_gateway_requests_total';
const GW_DUR = 'checkoutos_gateway_request_duration';

const overview = dashboard({
  uid: 'checkoutos-overview',
  title: 'checkoutOs — Overview',
  description: 'HTTP RED and the payment funnel. Start here.',
  tags: ['overview'],
  variables: [gatewayVariable],
  build: () => [
    row('Health'),
    stat('Scrape up', 'min(up{job="checkoutos"})', {
      lines: [],
      description: '1 = Prometheus can scrape /metrics. Alert: MetricsEndpointDown.',
    }),
    stat('API requests / s', `sum(rate(${HTTP}_count[$__rate_interval]))`, { unit: 'reqps' }),
    stat(
      'API 5xx ratio',
      ratio(
        `sum(rate(${HTTP}_count{http_response_status_code=~"5.."}[$__rate_interval]))`,
        `sum(rate(${HTTP}_count[$__rate_interval]))`,
      ),
      { unit: 'percentunit', lines: [0.01, 0.05] },
    ),
    stat('API p95 latency', quantile(0.95, HTTP, ''), { unit: 's', lines: [0.5, 1] }),

    row('HTTP (RED)'),
    timeseries(
      'Requests by route',
      [
        [
          rate(`${HTTP}_count`, 'http_route, http_request_method'),
          '{{http_request_method}} {{http_route}}',
        ],
      ],
      { unit: 'reqps' },
    ),
    timeseries(
      'Responses by status',
      [[rate(`${HTTP}_count`, 'http_response_status_code'), '{{http_response_status_code}}']],
      { unit: 'reqps', stack: true },
    ),
    timeseries('p95 latency by route', [[quantile(0.95, HTTP, 'http_route'), '{{http_route}}']], {
      unit: 's',
      lines: [1],
      description: 'Threshold line at 1s — a bucket boundary.',
    }),
    timeseries('p99 latency by route', [[quantile(0.99, HTTP, 'http_route'), '{{http_route}}']], {
      unit: 's',
      lines: [2.5],
    }),

    row('Payment funnel'),
    stat(
      'Payments created (range)',
      `sum(increase(checkoutos_payments_created_total{${G}}[$__range]))`,
      { w: 6 },
    ),
    stat(
      'Webhook captures (range)',
      `sum(increase(checkoutos_payment_transitions_total{${G}, to="SUCCESS", source="webhook"}[$__range]))`,
      { w: 6 },
    ),
    stat(
      'Refunds created (range)',
      `sum(increase(checkoutos_refunds_total{${G}, outcome="created"}[$__range]))`,
      { w: 6 },
    ),
    stat(
      'Refunded (range, ₹)',
      `sum(increase(checkoutos_refund_amount_minor_total{${G}, currency="INR"}[$__range])) / 100`,
      {
        w: 6,
        unit: 'currencyINR',
        description: 'refund.amount_minor is in paise; divided by 100.',
      },
    ),
    timeseries(
      'Payments created by gateway and status',
      [[rate('checkoutos_payments_created_total', 'gateway, status', G), '{{gateway}} {{status}}']],
      { unit: 'ops' },
    ),
    timeseries(
      'Status transitions',
      [
        [
          rate('checkoutos_payment_transitions_total', 'from, to, source', G),
          '{{from}} → {{to}} ({{source}})',
        ],
      ],
      { unit: 'ops' },
    ),
    timeseries(
      'Refunds by outcome',
      [[rate('checkoutos_refunds_total', 'gateway, outcome', G), '{{gateway}} {{outcome}}']],
      { unit: 'ops', stack: true },
    ),
    timeseries(
      'Captured but awaiting webhook',
      [[rate('checkoutos_gateway_poll_success_suppressed_total', 'gateway', G), '{{gateway}}']],
      {
        unit: 'ops',
        lines: [0],
        description:
          'Polls that saw SUCCESS but were held back (SUCCESS is webhook-only). Any sustained value: webhooks are not arriving. Alert: PaymentsAwaitingWebhook.',
      },
    ),
  ],
});

const gateways = dashboard({
  uid: 'checkoutos-gateways',
  title: 'checkoutOs — Gateways',
  description: 'Per-gateway latency and errors — the failover view.',
  tags: ['gateways'],
  variables: [gatewayVariable],
  build: () => [
    row('Payment creation'),
    stat(
      'createPayment failure ratio',
      ratio(
        `sum(rate(${GW}{${G}, operation="createPayment", outcome!="success"}[$__rate_interval]))`,
        `sum(rate(${GW}{${G}, operation="createPayment"}[$__rate_interval]))`,
      ),
      {
        unit: 'percentunit',
        lines: [0.02],
        w: 8,
        description: 'Alert at 2% for 5m: PaymentCreationFailureRate.',
      },
    ),
    stat('createPayment p99', quantile(0.99, GW_DUR, '', `${G}, operation="createPayment"`), {
      unit: 's',
      lines: [5, 8],
      w: 8,
    }),
    stat('Timeouts (range)', `sum(increase(${GW}{${G}, outcome="timeout"}[$__range]))`, { w: 8 }),
    timeseries(
      'createPayment failure ratio by gateway',
      [
        [
          ratio(
            rate(GW, 'gateway', `${G}, operation="createPayment", outcome!="success"`),
            rate(GW, 'gateway', `${G}, operation="createPayment"`),
          ),
          '{{gateway}}',
        ],
      ],
      { unit: 'percentunit', lines: [0.02], w: 24 },
    ),

    row('Calls'),
    timeseries(
      'Calls by operation and outcome',
      [[rate(GW, 'gateway, operation, outcome', G), '{{gateway}} {{operation}} {{outcome}}']],
      { unit: 'reqps' },
    ),
    timeseries(
      'Errors by outcome',
      [[rate(GW, 'gateway, outcome', `${G}, outcome!="success"`), '{{gateway}} {{outcome}}']],
      { unit: 'reqps', stack: true },
    ),

    row('Latency'),
    timeseries(
      'p99 by operation',
      [[quantile(0.99, GW_DUR, 'gateway, operation', G), '{{gateway}} {{operation}}']],
      {
        unit: 's',
        lines: [8],
        description:
          'Line at 8s = 80% of the 10s timeout, a bucket boundary. Alert: GatewayLatencyP99High.',
      },
    ),
    timeseries(
      'p50 / p95 / p99 (all operations)',
      [
        [quantile(0.5, GW_DUR, 'gateway', G), 'p50 {{gateway}}'],
        [quantile(0.95, GW_DUR, 'gateway', G), 'p95 {{gateway}}'],
        [quantile(0.99, GW_DUR, 'gateway', G), 'p99 {{gateway}}'],
      ],
      { unit: 's', lines: [8] },
    ),
    timeseries(
      'Outbound HTTP by host',
      [
        [
          rate(
            'checkoutos_http_client_request_duration_count',
            'server_address, http_response_status_code',
          ),
          '{{server_address}} {{http_response_status_code}}',
        ],
      ],
      { unit: 'reqps', w: 24, description: 'Every outbound call, including the webhook relay.' },
    ),
  ],
});

const webhooks = dashboard({
  uid: 'checkoutos-webhooks',
  title: 'checkoutOs — Webhooks',
  description: 'Inbound delivery, signature failures, state machine, and relay health.',
  tags: ['webhooks'],
  variables: [gatewayVariable],
  build: () => [
    row('Inbound'),
    stat(
      'Signature failures (range)',
      `sum(increase(checkoutos_webhook_signature_failures_total{${G}}[$__range]))`,
      {
        lines: [1],
        description:
          'Any sustained rate: wrong webhook secret or forgery. Alert: GatewaySignatureFailures.',
      },
    ),
    stat(
      'Unknown payment (range)',
      `sum(increase(checkoutos_webhook_unknown_payment_total{${G}}[$__range]))`,
      { lines: [1] },
    ),
    stat(
      'Blocked transitions (range)',
      `sum(increase(checkoutos_payment_transitions_blocked_total{${G}}[$__range]))`,
      { lines: [1] },
    ),
    stat('Processing p99', quantile(0.99, 'checkoutos_webhook_processing_duration', '', G), {
      unit: 's',
      lines: [0.25, 1],
    }),
    timeseries(
      'Received by result',
      [[rate('checkoutos_webhook_received_total', 'gateway, result', G), '{{gateway}} {{result}}']],
      { unit: 'ops', stack: true },
    ),
    timeseries(
      'Received by gateway event',
      [[rate('checkoutos_webhook_received_total', 'gateway, event', G), '{{gateway}} {{event}}']],
      { unit: 'ops' },
    ),
    timeseries(
      'Signature failures',
      [[rate('checkoutos_webhook_signature_failures_total', 'gateway', G), '{{gateway}}']],
      { unit: 'ops', lines: [0] },
    ),
    timeseries(
      'Blocked transitions',
      [
        [
          rate('checkoutos_payment_transitions_blocked_total', 'gateway, from, to', G),
          '{{gateway}} {{from}} → {{to}}',
        ],
      ],
      {
        unit: 'ops',
        description:
          'A steady stream of one from → to pair: a gateway event mapped to the wrong status. Alert: TransitionsBlockedSpike.',
      },
    ),
    timeseries(
      'Processing latency (excludes relay)',
      [
        [quantile(0.5, 'checkoutos_webhook_processing_duration', 'gateway', G), 'p50 {{gateway}}'],
        [quantile(0.99, 'checkoutos_webhook_processing_duration', 'gateway', G), 'p99 {{gateway}}'],
      ],
      { unit: 's', lines: [0.25], w: 24 },
    ),

    row('Relay to merchant (WEBHOOK_RELAY_URL)'),
    stat(
      'Relay failure ratio',
      ratio(
        `sum(rate(checkoutos_webhook_relay_attempts_total{outcome!="success"}[$__rate_interval]))`,
        `sum(rate(checkoutos_webhook_relay_attempts_total[$__rate_interval]))`,
      ),
      {
        unit: 'percentunit',
        lines: [0.05],
        w: 8,
        description: 'Alert at 5% for 10m: WebhookRelayFailing.',
      },
    ),
    stat('Relay p99', quantile(0.99, 'checkoutos_webhook_relay_duration', ''), {
      unit: 's',
      lines: [2.5, 5],
      w: 8,
      description:
        'The relay is awaited before checkoutOs answers the gateway; 5s is the relay timeout.',
    }),
    stat(
      'Relay timeouts (range)',
      `sum(increase(checkoutos_webhook_relay_attempts_total{outcome="timeout"}[$__range]))`,
      { w: 8 },
    ),
    timeseries(
      'Relay attempts by outcome',
      [[rate('checkoutos_webhook_relay_attempts_total', 'outcome'), '{{outcome}}']],
      { unit: 'ops', stack: true },
    ),
    timeseries(
      'Relay latency',
      [
        [quantile(0.5, 'checkoutos_webhook_relay_duration', ''), 'p50'],
        [quantile(0.99, 'checkoutos_webhook_relay_duration', ''), 'p99'],
      ],
      { unit: 's', lines: [5], description: 'Line at the 5s relay timeout — a bucket boundary.' },
    ),
  ],
});

const idempotency = dashboard({
  uid: 'checkoutos-idempotency',
  title: 'checkoutOs — Idempotency',
  description: 'Idempotency-Key decisions, retries, races and orderId dedup on POST /payments.',
  tags: ['idempotency'],
  build: () => [
    row('Idempotency-Key'),
    stat(
      'Hit ratio',
      ratio(
        `sum(rate(checkoutos_idempotency_decisions_total{result="hit"}[$__rate_interval]))`,
        `sum(rate(checkoutos_idempotency_decisions_total[$__rate_interval]))`,
      ),
      {
        unit: 'percentunit',
        description:
          'Share of POST /payments that were replays. A sudden rise: clients are retrying, so something upstream is failing.',
      },
    ),
    stat(
      'In progress → 409 (range)',
      `sum(increase(checkoutos_idempotency_decisions_total{result="in_progress"}[$__range]))`,
      { lines: [1] },
    ),
    stat(
      'Key reused with a different body (range)',
      `sum(increase(checkoutos_idempotency_decisions_total{result="hash_mismatch"}[$__range]))`,
      { lines: [1] },
    ),
    stat(
      'Stale claims recovered (range)',
      `sum(increase(checkoutos_idempotency_decisions_total{result="stale_recovered"}[$__range]))`,
      {
        lines: [1],
        description:
          'An IN_PROGRESS claim older than 30s was taken over — a request died mid-create.',
      },
    ),
    timeseries(
      'Decisions',
      [[rate('checkoutos_idempotency_decisions_total', 'result'), '{{result}}']],
      { unit: 'ops', stack: true, w: 24 },
    ),

    row('orderId dedup'),
    timeseries(
      'Reservation conflicts by resolution',
      [[rate('checkoutos_orderid_reservation_conflicts_total', 'result'), '{{result}}']],
      {
        unit: 'ops',
        stack: true,
        description:
          'deduplicated = existing payment served; in_progress = concurrent create → 409; *_mismatch = same orderId, different amount/currency → 409.',
      },
    ),
    stat(
      'Concurrent creates (range)',
      `sum(increase(checkoutos_orderid_reservation_conflicts_total{result="in_progress"}[$__range]))`,
      { w: 6 },
    ),
    stat(
      'Mismatched reuse (range)',
      `sum(increase(checkoutos_orderid_reservation_conflicts_total{result=~"amount_mismatch|currency_mismatch"}[$__range]))`,
      { w: 6, lines: [1] },
    ),
  ],
});

const DASHBOARDS = {
  'checkoutos-overview.json': overview,
  'checkoutos-gateways.json': gateways,
  'checkoutos-webhooks.json': webhooks,
  'checkoutos-idempotency.json': idempotency,
};

// ── Output ──────────────────────────────────────────────────────────────────

function flatPanels(list) {
  return list.flatMap((panel) => [panel, ...flatPanels(panel.panels ?? [])]);
}

function promqlRules() {
  // Grafana variables → values promtool accepts.
  const concrete = (expr) =>
    expr
      .replaceAll('$__rate_interval', '5m')
      .replaceAll('$__range', '1h')
      .replaceAll('$gateway', '.*');
  const lines = [
    '# GENERATED by scripts/build-dashboards.mjs --promql-rules — syntax check only',
    'groups:',
  ];
  for (const [file, dash] of Object.entries(DASHBOARDS)) {
    lines.push(`  - name: ${JSON.stringify(file)}`, '    rules:');
    flatPanels(dash.panels).forEach((panel) => {
      (panel.targets ?? []).forEach((target, i) => {
        lines.push(
          `      - record: dashboard:panel${panel.id}_${i}`,
          `        expr: ${JSON.stringify(concrete(target.expr))}`,
        );
      });
    });
  }
  return `${lines.join('\n')}\n`;
}

let stale = [];
mkdirSync(OUT_DIR, { recursive: true });
for (const [file, dash] of Object.entries(DASHBOARDS)) {
  const path = join(OUT_DIR, file);
  const next = `${JSON.stringify(dash, null, 2)}\n`;
  let previous;
  try {
    previous = readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
  } catch {
    previous = undefined;
  }
  if (previous === next) continue;
  if (CHECK) stale.push(file);
  else {
    writeFileSync(path, next);
    console.log(`wrote ${path}`);
  }
}

if (RULES_OUT !== undefined) writeFileSync(RULES_OUT, promqlRules());

if (stale.length > 0) {
  console.error(
    `✗ stale dashboards: ${stale.join(', ')} — run node scripts/build-dashboards.mjs and commit`,
  );
  process.exit(1);
}
console.log(CHECK ? '✓ dashboards up to date' : 'dashboards built');
