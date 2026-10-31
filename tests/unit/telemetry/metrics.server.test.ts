// tests/unit/telemetry/metrics.server.test.ts
// Unit tests for the internal /metrics listener (ADR 003 §3.5).
//
// Business invariants protected:
//   - With METRICS_AUTH_TOKEN set, nothing is served without the exact bearer
//     token — the endpoint exposes payment volumes and revenue shape
//   - Auth runs before routing, so unauthenticated callers learn nothing
//   - A bind failure surfaces through `ready` (the boot check reports it)
//     instead of crashing the process as an unhandled 'error' event
//   - stop() releases the port even with keep-alive scrapers attached
//
// The Prometheus exporter is stubbed: rendering is the exporter's job; this
// suite covers the socket, routing and auth that this module owns.

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import type { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import {
  isAuthorized,
  startMetricsServer,
  type MetricsServer,
} from '../../../src/telemetry/metrics.server';

const TOKEN = 'test-token-0123456789';

const exporterStub = {
  getMetricsRequestHandler: (_req: unknown, res: { end: (body: string) => void }) => {
    res.end('checkoutos_build_info{version="test"} 1\n');
  },
} as unknown as PrometheusExporter;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

let servers: MetricsServer[] = [];

async function start(authToken: string | undefined): Promise<MetricsServer> {
  const server = startMetricsServer({ port: await freePort(), authToken, exporter: exporterStub });
  servers.push(server);
  await server.ready;
  return server;
}

function get(server: MetricsServer, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, init);
}

afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  servers = [];
});

// ---------------------------------------------------------------------------
// isAuthorized
// ---------------------------------------------------------------------------

describe('isAuthorized', () => {
  it('allows everything when no token is configured', () => {
    expect(isAuthorized(undefined, undefined)).toBe(true);
    expect(isAuthorized('Bearer anything', undefined)).toBe(true);
  });

  it('accepts the exact bearer token', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['wrong token', 'Bearer wrong-token'],
    ['token without scheme', TOKEN],
    ['wrong scheme', `Basic ${TOKEN}`],
    ['token prefix only', `Bearer ${TOKEN.slice(0, 5)}`],
    ['token with suffix', `Bearer ${TOKEN}x`],
  ])('rejects %s', (_label, header) => {
    expect(isAuthorized(header, TOKEN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startMetricsServer
// ---------------------------------------------------------------------------

describe('startMetricsServer — with a token', () => {
  it('serves /metrics to the token holder', async () => {
    const server = await start(TOKEN);

    const res = await get(server, '/metrics', { headers: { authorization: `Bearer ${TOKEN}` } });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('checkoutos_build_info');
  });

  it('answers 401 without the token', async () => {
    const server = await start(TOKEN);

    const res = await get(server, '/metrics');

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('answers 401 for unknown paths too — auth runs before routing', async () => {
    const server = await start(TOKEN);

    expect((await get(server, '/nope')).status).toBe(401);
  });
});

describe('startMetricsServer — routing', () => {
  it('serves /metrics without auth when no token is configured', async () => {
    const server = await start(undefined);

    expect((await get(server, '/metrics')).status).toBe(200);
  });

  it('ignores the query string', async () => {
    const server = await start(undefined);

    expect((await get(server, '/metrics?x=1')).status).toBe(200);
  });

  it('answers 404 for any other path', async () => {
    const server = await start(undefined);

    expect((await get(server, '/health')).status).toBe(404);
  });

  it('answers 405 for non-GET methods', async () => {
    const server = await start(undefined);

    const res = await get(server, '/metrics', { method: 'POST' });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('startMetricsServer — lifecycle', () => {
  it('rejects `ready` when the port is taken, without throwing', async () => {
    const first = await start(undefined);

    const second = startMetricsServer({
      port: first.port,
      authToken: undefined,
      exporter: exporterStub,
    });
    servers.push(second);

    await expect(second.ready).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('releases the port on stop()', async () => {
    const server = await start(undefined);
    await get(server, '/metrics'); // leave a keep-alive connection behind

    await server.stop();

    const again = startMetricsServer({
      port: server.port,
      authToken: undefined,
      exporter: exporterStub,
    });
    servers.push(again);
    await expect(again.ready).resolves.toBeUndefined();
  });

  it('stop() is safe on a server that never bound', async () => {
    const first = await start(undefined);
    const failed = startMetricsServer({
      port: first.port,
      authToken: undefined,
      exporter: exporterStub,
    });
    await expect(failed.ready).rejects.toBeDefined();

    await expect(failed.stop()).resolves.toBeUndefined();
  });
});
