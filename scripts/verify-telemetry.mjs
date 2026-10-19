// scripts/verify-telemetry.mjs
// End-to-end telemetry check against the REAL entry points. See ADR 003 §5 Phase 0.
//
//   npm run verify:telemetry            # verify, and (re)write the snapshot
//   npm run verify:telemetry -- --check # verify; fail if the snapshot is stale
//
// For both `npm start` (compiled CJS, --require preload) and `npm run dev`
// (tsx/ESM, --import loader hook):
//   1. boot the app on spare ports, with a random METRICS_AUTH_TOKEN
//   2. GET /health on the API port (must be 200)
//   3. assert /metrics answers 401 without the token
//   4. assert /metrics (with the token) contains
//        http_route="/health"     → HttpInstrumentation + Express patched
//        checkoutos_build_info    → provider wiring intact (ADR 003 §3.4)
//   5. assert the HTTP histogram is emitted exactly once (never hand-defined,
//      ADR 003 §5 Phase 2b) and carries the stable-semconv label keys
//        http_route, http_request_method, http_response_status_code
//   6. assert nothing connected to localhost:4318 → no default OTLP egress
//   7. reduce the exposition to its SHAPE — metric names, HELP/UNIT/TYPE,
//      label keys, histogram `le` boundaries; never values — and require both
//      entry points to produce the same one. It is written to
//      observability/exposition.snapshot.txt; CI fails when that file changes
//      without being committed (ADR 003 §7.3).
//
// Why not a vitest project: the thing under test IS the bootstrap wiring —
// tracing.ts, register.mjs and the start/dev commands. A test that builds its
// own provider passes while production emits nothing.
//
// Hermetic: the app talks to a local stub gateway (any request → 200), so no
// gateway credentials or internet are needed, /health is a deterministic 200
// and the snapshot does not depend on whether Razorpay is reachable.
//
// Requires Redis (REDIS_URL from the environment or .env, default
// redis://localhost:6379). Exits non-zero on any failure.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import dotenv from 'dotenv';

// The same .env the app would load, so REDIS_URL etc. match a local run.
// Never overrides variables that are already set (CI sets them explicitly).
dotenv.config({ quiet: true });

const PORT = Number(process.env.VERIFY_PORT ?? 3100);
const METRICS_PORT = Number(process.env.VERIFY_METRICS_PORT ?? 9564);
const GATEWAY_PORT = Number(process.env.VERIFY_GATEWAY_PORT ?? 9590);
const OTLP_PORT = 4318;
const BOOT_TIMEOUT_MS = 90_000;
const TOKEN = randomBytes(24).toString('hex');
const IS_WINDOWS = process.platform === 'win32';
const SNAPSHOT_PATH = 'observability/exposition.snapshot.txt';
const CHECK_ONLY = process.argv.includes('--check');

// npm is npm.cmd on Windows, which needs a shell. With a shell, pass one
// command string — args alongside shell: true are deprecated (DEP0190).
function npm(script, options) {
  return IS_WINDOWS
    ? [`npm run ${script}`, [], { ...options, shell: true }]
    : ['npm', ['run', script], options];
}

const TARGETS = [
  { name: 'npm start', script: 'start', nodeEnv: 'production' },
  { name: 'npm run dev', script: 'dev', nodeEnv: 'development' },
];

// ── OTLP trap ───────────────────────────────────────────────────────────────
// Rather than only checking that nothing listens on 4318, listen there
// ourselves and fail if the app connects: that proves the app does not try.

function startOtlpTrap() {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(
        new Error(
          `cannot bind the OTLP trap on :${OTLP_PORT} (${err.code}). ` +
            'Stop any local collector and rerun.',
        ),
      );
    });
    // '::' with dual-stack covers both localhost resolutions (::1 and 127.0.0.1).
    server.listen({ port: OTLP_PORT, host: '::', ipv6Only: false }, () => {
      resolve({
        connections: () => connections,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ── Stub gateway ────────────────────────────────────────────────────────────
// Just enough of the Razorpay API for the business flow below: create an
// order, create a refund, and 200 for anything else (healthCheck() counts any
// response as healthy). Always 200, which also keeps error_type off the
// http.client histogram, so its label keys are the same on every machine.

// Fresh IDs per created order: Redis outlives a run, and a reused gateway ID
// would make the signed webhook resolve to the previous run's payment.
const stub = { orderId: '', paymentId: '' };

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function startStubGateway() {
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const now = Math.floor(Date.now() / 1000);
    let reply = { items: [] };
    if (req.method === 'POST' && req.url === '/orders') {
      const suffix = randomBytes(7).toString('hex');
      stub.orderId = `order_${suffix}`;
      stub.paymentId = `pay_${suffix}`;
      reply = {
        id: stub.orderId,
        entity: 'order',
        amount: body.amount,
        amount_paid: 0,
        amount_due: body.amount,
        currency: body.currency ?? 'INR',
        receipt: body.receipt,
        status: 'created',
        attempts: 0,
        created_at: now,
      };
    } else if (req.method === 'POST' && /^\/payments\/[^/]+\/refunds$/.test(req.url ?? '')) {
      reply = {
        id: 'rfnd_verify0000001',
        entity: 'refund',
        amount: body.amount,
        currency: 'INR',
        payment_id: stub.paymentId,
        status: 'processed',
        created_at: now,
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(new Error(`cannot bind the stub gateway on :${GATEWAY_PORT} (${err.code})`));
    });
    server.listen(GATEWAY_PORT, '127.0.0.1', () => {
      resolve({ close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

// ── Process control ─────────────────────────────────────────────────────────

function childEnv(nodeEnv) {
  // Test the defaults: no OTLP endpoint, no exporter overrides.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^OTEL_(EXPORTER_|TRACES_EXPORTER|METRICS_EXPORTER|LOGS_EXPORTER)/.test(key),
    ),
  );
  return {
    ...env,
    NODE_ENV: nodeEnv,
    PORT: String(PORT),
    METRICS_PORT: String(METRICS_PORT),
    METRICS_AUTH_TOKEN: TOKEN,
    REDIS_URL: env.REDIS_URL ?? 'redis://localhost:6379',
    // Always local: the business flow relays a webhook, and the run must not
    // reach a real merchant endpoint. Port 9 refuses → relay network_error.
    WEBHOOK_RELAY_URL: 'http://127.0.0.1:9/relay',
    ACTIVE_GATEWAY: 'razorpay',
    RAZORPAY_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
    RAZORPAY_KEY_ID: 'rzp_test_verify',
    RAZORPAY_KEY_SECRET: 'verify',
    RAZORPAY_WEBHOOK_SECRET: 'verify',
  };
}

function launch(script, env) {
  const child = spawn(
    ...npm(script, {
      env,
      detached: !IS_WINDOWS, // own process group, so the whole tree can be killed
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  const output = [];
  const collect = (chunk) => {
    output.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
    if (output.length > 80) output.splice(0, output.length - 80);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let exitCode = null;
  child.on('exit', (code) => {
    exitCode = code ?? -1;
  });
  return { child, output, exited: () => exitCode !== null, exitCode: () => exitCode };
}

async function killTree(proc) {
  if (proc.exited()) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(proc.child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-proc.child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  for (let i = 0; i < 50 && !proc.exited(); i += 1) await sleep(200);
  if (!proc.exited() && !IS_WINDOWS) {
    try {
      process.kill(-proc.child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

async function waitForPortFree(port) {
  for (let i = 0; i < 50; i += 1) {
    const inUse = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (!inUse) return;
    await sleep(200);
  }
}

// ── Checks ──────────────────────────────────────────────────────────────────

async function waitForHealth(proc) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exited()) {
      throw new Error(`app exited during startup (code ${proc.exitCode()})`);
    }
    let status;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      await res.arrayBuffer();
      status = res.status;
    } catch {
      // not listening yet
    }
    // 200 only: a 503 adds error_type to the histogram and changes the
    // snapshot. With the stub gateway, anything else means Redis is down.
    if (status === 200) return status;
    await sleep(500);
  }
  throw new Error(
    `app did not answer /health with 200 within ${BOOT_TIMEOUT_MS / 1000}s — is Redis up?`,
  );
}

async function scrape(token) {
  const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  return { status: res.status, body: await res.text() };
}

// ── Exposition shape ────────────────────────────────────────────────────────

// Parses `a="x",b="y\"z"` into [[key, value], ...]. Values may contain escaped
// quotes and commas (target_info's process_command_args), so scan, don't split.
function parseLabels(text) {
  const labels = [];
  let i = 0;
  while (i < text.length) {
    const eq = text.indexOf('="', i);
    if (eq === -1) break;
    const key = text.slice(i, eq).replace(/^,/, '').trim();
    let j = eq + 2;
    let value = '';
    while (j < text.length && text[j] !== '"') {
      if (text[j] === '\\') {
        value += text[j + 1];
        j += 2;
      } else {
        value += text[j];
        j += 1;
      }
    }
    labels.push([key, value]);
    i = j + 1;
  }
  return labels;
}

const SAMPLE_SUFFIX = /_(bucket|count|sum|total|created)$/;

// target_info carries resource attributes. The host_* / process_* ones come
// from the SDK's detectors and differ by OS (Linux adds host_id), so only the
// ones tracing.ts sets are contract.
const OWN_RESOURCE_KEY = /^(service_|deployment_)/;

// Contract, not data: names, HELP/UNIT/TYPE, label keys and `le` boundaries.
// Sample values and label values are dropped, and families are sorted, so the
// order in which instruments first recorded does not matter.
function expositionShape(body) {
  const families = new Map();
  const family = (name) => {
    if (!families.has(name)) families.set(name, { meta: new Set(), series: new Map() });
    return families.get(name);
  };

  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const meta = /^# (HELP|UNIT|TYPE) (\S+)/.exec(line);
    if (meta) {
      family(meta[2]).meta.add(line);
      continue;
    }
    if (line.startsWith('#')) continue;
    const sample = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s/.exec(line);
    if (!sample) continue;
    const [, metric, labelText = ''] = sample;
    const base = families.has(metric) ? metric : metric.replace(SAMPLE_SUFFIX, '');
    const labels = parseLabels(labelText);
    const keys = labels
      .map(([key]) => key)
      .filter((key) => key !== 'le')
      .filter((key) => base !== 'target_info' || OWN_RESOURCE_KEY.test(key));
    const id = `${metric}{${keys.sort().join(',')}}`;
    const series = family(base).series;
    if (!series.has(id)) series.set(id, []);
    const le = labels.find(([key]) => key === 'le')?.[1];
    if (le !== undefined && !series.get(id).includes(le)) series.get(id).push(le);
  }

  const META_ORDER = { HELP: 0, UNIT: 1, TYPE: 2 };
  const out = [];
  for (const name of [...families.keys()].sort()) {
    const { meta, series } = families.get(name);
    out.push(
      ...[...meta].sort((a, b) => META_ORDER[a.split(' ')[1]] - META_ORDER[b.split(' ')[1]]),
    );
    for (const id of [...series.keys()].sort()) {
      const boundaries = series.get(id);
      out.push(boundaries.length > 0 ? `${id} le=${boundaries.join(',')}` : id);
    }
    out.push('');
  }
  return out.join('\n');
}

// ADR 003 §5 Phase 2b: the instrumentation's own histogram, with semconv keys.
const HTTP_LABELS = ['http_route', 'http_request_method', 'http_response_status_code'];

function checkHttpHistogram(body) {
  const failures = [];
  const families = body.match(/^# TYPE \w*http_server_request_duration\w* /gm) ?? [];
  if (families.length !== 1) {
    failures.push(
      `expected exactly one http.server.request.duration family, found ${families.length} — ` +
        'never hand-define it; HttpInstrumentation already emits it',
    );
  }
  const series = /^\w*http_server_request_duration\w*_count\{([^}]*)\}/m.exec(body)?.[1];
  if (series !== undefined) {
    const keys = parseLabels(series).map(([key]) => key);
    const missing = HTTP_LABELS.filter((key) => !keys.includes(key));
    if (missing.length > 0) {
      failures.push(`HTTP histogram is missing label key(s): ${missing.join(', ')}`);
    }
  }
  return failures;
}

// ── Business flow ───────────────────────────────────────────────────────────
// Instruments appear in /metrics only once they have recorded, so drive one
// pass through the main paths — otherwise the snapshot would pin almost none
// of the catalogue (ADR 003 §6). Against the stub gateway, with the webhook
// secret from childEnv, so the signed webhook verifies.

const API = `http://127.0.0.1:${PORT}`;
const WEBHOOK_SECRET = 'verify';

async function call(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined && { body }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function expectStatus(step, { status }, expected) {
  if (status !== expected) throw new Error(`${step} answered ${status}, expected ${expected}`);
}

async function driveBusinessFlow() {
  const orderId = `VERIFY-${randomBytes(6).toString('hex')}`;
  const payment = JSON.stringify({ amount: 50000, currency: 'INR', orderId });
  const idempotency = { 'idempotency-key': randomUUID() };

  // payments.created, idempotency.decisions{miss}, gateway.*{createPayment}
  const created = await call('POST', '/payments', { body: payment, headers: idempotency });
  expectStatus('POST /payments', created, 201);
  const chkId = created.json?.data?.paymentId;

  // idempotency.decisions{hit}
  expectStatus(
    'POST /payments (replay)',
    await call('POST', '/payments', { body: payment, headers: idempotency }),
    201,
  );

  // webhook.signature_failures, webhook.received{rejected}
  await call('POST', '/webhooks/razorpay', {
    body: '{}',
    headers: { 'x-razorpay-signature': '00'.repeat(32) },
  });

  // orderid.reservation_conflicts{deduplicated} — same orderId, new key
  expectStatus(
    'POST /payments (same orderId)',
    await call('POST', '/payments', {
      body: payment,
      headers: { 'idempotency-key': randomUUID() },
    }),
    201,
  );

  // webhook.received{updated}, payment.transitions{webhook}, relay.* —
  // the relay goes to WEBHOOK_RELAY_URL (port 9, refused → network_error)
  expectStatus('POST /webhooks/razorpay', await sendCaptured(stub.orderId, stub.paymentId), 200);

  // refunds{created}, refund.amount_minor, payment.transitions{refund}
  expectStatus(
    'POST /payments/:chkId/refund',
    await call('POST', `/payments/${chkId}/refund`, { body: JSON.stringify({ amount: 10000 }) }),
    201,
  );

  // payment.transitions_blocked — captured again on a PARTIALLY_REFUNDED payment
  expectStatus(
    'POST /webhooks/razorpay (replay)',
    await sendCaptured(stub.orderId, stub.paymentId),
    200,
  );

  // webhook.unknown_payment — signed, but for IDs no payment has
  expectStatus(
    'POST /webhooks/razorpay (unknown)',
    await sendCaptured('order_unknown0000000', 'pay_unknown00000000'),
    200,
  );
}

function sendCaptured(orderId, paymentId) {
  const captured = JSON.stringify({
    entity: 'event',
    account_id: 'acc_verify',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: 'payment',
          amount: 50000,
          currency: 'INR',
          status: 'captured',
          order_id: orderId,
          created_at: Math.floor(Date.now() / 1000),
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(captured).digest('hex');
  return call('POST', '/webhooks/razorpay', {
    body: captured,
    headers: { 'x-razorpay-signature': signature },
  });
}

// Families the flow above must produce. Prefix/suffix-agnostic: exact names
// are the snapshot's job.
const BUSINESS_FAMILIES = [
  'gateway_request_duration',
  'gateway_requests_total',
  'payments_created_total',
  'payment_transitions_total',
  'payment_transitions_blocked_total',
  'webhook_unknown_payment_total',
  'orderid_reservation_conflicts_total',
  'webhook_received_total',
  'webhook_signature_failures_total',
  'webhook_processing_duration',
  'webhook_relay_attempts_total',
  'webhook_relay_duration',
  'idempotency_decisions_total',
  'refunds_total',
  'refund_amount_minor_total',
];

function checkBusinessFamilies(body) {
  return BUSINESS_FAMILIES.filter(
    (family) => !new RegExp(`^# TYPE \\w*${family} `, 'm').test(body),
  ).map((family) => `business metric ${family} missing after the business flow`);
}

async function verifyTarget(target, trap) {
  const failures = [];
  let shape;
  const before = trap.connections();
  const proc = launch(target.script, childEnv(target.nodeEnv));

  try {
    const healthStatus = await waitForHealth(proc);
    console.log(`  /health answered ${healthStatus}`);

    await driveBusinessFlow();
    console.log('  business flow: payment, replay, dedup, webhooks, refund');

    const anonymous = await scrape(undefined);
    if (anonymous.status !== 401) {
      failures.push(`/metrics without a token answered ${anonymous.status}, expected 401`);
    }

    const { status, body } = await scrape(TOKEN);
    if (status !== 200) {
      failures.push(`/metrics with the token answered ${status}, expected 200`);
    }
    // Prefix- and unit-agnostic on purpose: exporter 0.223.0 renders
    // checkoutos_http_server_request_duration_count (prefix applied, no unit
    // suffix). Exact names are the exposition snapshot's job (ADR 003 §7.3).
    if (!/^\w*http_server_request_duration\w*_count\{[^}]*http_route="\/health"/m.test(body)) {
      failures.push('no http_route="/health" series — HTTP/Express instrumentation not patched');
    }
    if (!body.includes('checkoutos_build_info')) {
      failures.push('checkoutos_build_info missing — instruments not reaching the exposition');
    }
    failures.push(...checkHttpHistogram(body));
    failures.push(...checkBusinessFamilies(body));
    shape = expositionShape(body);
  } catch (err) {
    failures.push(err.message);
  } finally {
    await killTree(proc);
    await Promise.all([waitForPortFree(PORT), waitForPortFree(METRICS_PORT)]);
  }

  const otlpConnections = trap.connections() - before;
  if (otlpConnections > 0) {
    failures.push(
      `${otlpConnections} connection(s) to localhost:${OTLP_PORT} — default OTLP egress`,
    );
  }

  if (failures.length > 0) {
    console.log('  --- last app output ---');
    for (const line of proc.output.slice(-25)) console.log(`  | ${line}`);
  }
  return { failures, shape };
}

// ── Snapshot ────────────────────────────────────────────────────────────────

const SNAPSHOT_HEADER = `# GENERATED by scripts/verify-telemetry.mjs — do not edit by hand.
# The SHAPE of /metrics (ADR 003 §7.3): metric names, HELP/UNIT/TYPE, label
# keys and histogram boundaries — never values. A diff here is a change to the
# public metric contract: review it as one, then commit this file.

`;

function compareShapes(start, dev) {
  if (start === dev) return true;
  console.log('\n✗ npm start and npm run dev expose different metric shapes:');
  const startLines = new Set(start.split('\n'));
  const devLines = new Set(dev.split('\n'));
  for (const line of startLines) if (!devLines.has(line)) console.log(`  - start only: ${line}`);
  for (const line of devLines) if (!startLines.has(line)) console.log(`  + dev only:   ${line}`);
  return false;
}

function updateSnapshot(shape) {
  const next = SNAPSHOT_HEADER + shape;
  let previous;
  try {
    previous = readFileSync(SNAPSHOT_PATH, 'utf-8').replace(/\r\n/g, '\n');
  } catch {
    previous = undefined;
  }
  if (previous === next) {
    console.log(`\n✓ exposition shape unchanged (${SNAPSHOT_PATH})`);
    return true;
  }
  if (CHECK_ONLY) {
    console.log(
      `\n✗ exposition shape differs from ${SNAPSHOT_PATH} — ` +
        'run npm run verify:telemetry, review the diff and commit it',
    );
    return false;
  }
  writeFileSync(SNAPSHOT_PATH, next);
  console.log(
    `\n! exposition shape ${previous === undefined ? 'written to' : 'CHANGED in'} ${SNAPSHOT_PATH}` +
      ' — review the diff and commit it (CI fails otherwise)',
  );
  return true;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Building (npm start runs the compiled output)…');
  const build = spawnSync(...npm('build', { stdio: 'inherit' }));
  if (build.status !== 0) {
    console.error('✗ build failed');
    process.exit(1);
  }

  const trap = await startOtlpTrap();
  const gateway = await startStubGateway();
  const shapes = [];
  let failed = false;

  try {
    for (const target of TARGETS) {
      console.log(`\n▶ ${target.name}  (API :${PORT}, metrics :${METRICS_PORT})`);
      const { failures, shape } = await verifyTarget(target, trap);
      shapes.push(shape);
      if (failures.length === 0) {
        console.log(`✓ ${target.name}`);
      } else {
        failed = true;
        for (const failure of failures) console.log(`✗ ${target.name}: ${failure}`);
      }
    }
  } finally {
    await Promise.all([trap.close(), gateway.close()]);
  }

  // Both entry points must expose the same contract: a family missing under
  // tsx/ESM means an instrumentation that only patches the CJS path.
  if (!failed) {
    const [start, dev] = shapes;
    failed = !compareShapes(start, dev) || !updateSnapshot(start);
  }

  console.log(failed ? '\nverify:telemetry FAILED' : '\nverify:telemetry passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`verify:telemetry crashed: ${err.stack ?? err}`);
  process.exit(1);
});
