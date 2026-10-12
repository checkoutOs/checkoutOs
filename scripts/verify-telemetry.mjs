// scripts/verify-telemetry.mjs
// End-to-end telemetry check against the REAL entry points. See ADR 003 §5 Phase 0.
//
//   npm run verify:telemetry
//
// For both `npm start` (compiled CJS, --require preload) and `npm run dev`
// (tsx/ESM, --import loader hook):
//   1. boot the app on spare ports, with a random METRICS_AUTH_TOKEN
//   2. GET /health on the API port
//   3. assert /metrics answers 401 without the token
//   4. assert /metrics (with the token) contains
//        http_route="/health"     → HttpInstrumentation + Express patched
//        checkoutos_build_info    → provider wiring intact (ADR 003 §3.4)
//   5. assert nothing connected to localhost:4318 → no default OTLP egress
//
// Why not a vitest project: the thing under test IS the bootstrap wiring —
// tracing.ts, register.mjs and the start/dev commands. A test that builds its
// own provider passes while production emits nothing.
//
// Requires Redis (REDIS_URL, as for the app itself) and the usual .env.
// Exits non-zero on any failure.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.VERIFY_PORT ?? 3100);
const METRICS_PORT = Number(process.env.VERIFY_METRICS_PORT ?? 9564);
const OTLP_PORT = 4318;
const BOOT_TIMEOUT_MS = 90_000;
const TOKEN = randomBytes(24).toString('hex');
const IS_WINDOWS = process.platform === 'win32';

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
    try {
      // Any HTTP status counts: the request only has to be served and measured.
      // /health may legitimately be 503 when the gateway is unreachable.
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      await res.arrayBuffer();
      return res.status;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`app did not answer /health within ${BOOT_TIMEOUT_MS / 1000}s`);
}

async function scrape(token) {
  const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  return { status: res.status, body: await res.text() };
}

async function verifyTarget(target, trap) {
  const failures = [];
  const before = trap.connections();
  const proc = launch(target.script, childEnv(target.nodeEnv));

  try {
    const healthStatus = await waitForHealth(proc);
    console.log(`  /health answered ${healthStatus}`);

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
  return failures;
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
  let failed = false;

  try {
    for (const target of TARGETS) {
      console.log(`\n▶ ${target.name}  (API :${PORT}, metrics :${METRICS_PORT})`);
      const failures = await verifyTarget(target, trap);
      if (failures.length === 0) {
        console.log(`✓ ${target.name}`);
      } else {
        failed = true;
        for (const failure of failures) console.log(`✗ ${target.name}: ${failure}`);
      }
    }
  } finally {
    await trap.close();
  }

  console.log(failed ? '\nverify:telemetry FAILED' : '\nverify:telemetry passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`verify:telemetry crashed: ${err.stack ?? err}`);
  process.exit(1);
});
