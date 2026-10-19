// tests/unit/telemetry/attributes.test.ts
// Unit tests for the metric label builders (ADR 003 §8.2).
//
// Business invariants protected:
//   - every label value comes from a closed set; anything outside it collapses
//     to one fallback value instead of a new time series — a chkId, orderId or
//     raw path can never become a label, even through a cast
//   - the closed sets track the code they mirror: supportedGateways in the
//     registry and the routes actually mounted in app.ts
//   - HTTP labels use the stable-semconv keys of http.server.request.duration
//   - builders never throw (telemetry must not break a payment path)

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  gatewayLabels,
  webhookLabels,
  httpLabels,
  buildInfoLabels,
  METRIC_GATEWAYS,
  HTTP_ROUTES,
  UNKNOWN,
  OTHER_METHOD,
  UNMATCHED_ROUTE,
  type GatewayOperation,
  type GatewayOutcome,
  type HttpRoute,
} from '../../../src/telemetry/attributes';
import { supportedGateways } from '../../../src/gateways/gateway.registry';

const SRC = resolve(__dirname, '../../../src');

// Routes mounted in app.ts: app.use('/prefix', xRouter) + xRouter.<verb>('/path').
function mountedRoutes(): string[] {
  const app = readFileSync(join(SRC, 'app.ts'), 'utf-8');
  const prefixes = new Map<string, string>();
  for (const [, prefix, router] of app.matchAll(/app\.use\('([^']+)',\s*(\w+Router)\)/g)) {
    prefixes.set(router!, prefix!);
  }
  const routes = new Set<string>();
  for (const file of readdirSync(join(SRC, 'routes'))) {
    const code = readFileSync(join(SRC, 'routes', file), 'utf-8');
    for (const [, router, path] of code.matchAll(
      /(\w+Router)\.(?:get|post|put|patch|delete)\('([^']+)'/g,
    )) {
      const prefix = prefixes.get(router!);
      if (prefix !== undefined) routes.add(`${prefix}${path}`.replace(/(.)\/$/, '$1'));
    }
  }
  return [...routes].sort();
}

describe('closed sets', () => {
  it('METRIC_GATEWAYS matches supportedGateways in the registry', () => {
    expect([...METRIC_GATEWAYS].sort()).toEqual([...supportedGateways].sort());
  });

  it('HTTP_ROUTES matches the routes mounted in app.ts', () => {
    const mounted = mountedRoutes();

    expect(mounted.length).toBeGreaterThan(5);
    expect([...HTTP_ROUTES].sort()).toEqual(mounted);
  });
});

describe('gatewayLabels', () => {
  it('passes values from the closed sets through', () => {
    expect(gatewayLabels('razorpay', 'createPayment', 'success')).toEqual({
      gateway: 'razorpay',
      operation: 'createPayment',
      outcome: 'success',
    });
  });

  it('collapses anything outside the sets to "unknown"', () => {
    expect(
      gatewayLabels('chk_a1b2c3d4', 'pay_XYZ' as GatewayOperation, 'order_123' as GatewayOutcome),
    ).toEqual({ gateway: UNKNOWN, operation: UNKNOWN, outcome: UNKNOWN });
  });

  it('emits only gateway, operation and outcome', () => {
    expect(Object.keys(gatewayLabels('paytm', 'healthCheck', 'timeout')).sort()).toEqual([
      'gateway',
      'operation',
      'outcome',
    ]);
  });
});

describe('webhookLabels', () => {
  it('labels by gateway only', () => {
    expect(webhookLabels('paytm')).toEqual({ gateway: 'paytm' });
  });

  it('collapses an unknown gateway', () => {
    expect(webhookLabels('evil-gateway')).toEqual({ gateway: UNKNOWN });
  });
});

describe('httpLabels', () => {
  it('uses the stable-semconv keys', () => {
    expect(httpLabels('GET', '/payments/:chkId', 200)).toEqual({
      'http.request.method': 'GET',
      'http.route': '/payments/:chkId',
      'http.response.status_code': 200,
    });
  });

  it('normalises method case and collapses unknown methods to _OTHER', () => {
    expect(httpLabels('post', '/payments', 201)['http.request.method']).toBe('POST');
    expect(httpLabels('BREW', '/payments', 418)['http.request.method']).toBe(OTHER_METHOD);
  });

  it('never lets a raw path through as a route', () => {
    expect(httpLabels('GET', '/payments/chk_a1b2c3d4' as HttpRoute, 200)['http.route']).toBe(
      UNMATCHED_ROUTE,
    );
    expect(httpLabels('GET', undefined, 404)['http.route']).toBe(UNMATCHED_ROUTE);
  });

  it('maps an impossible status code to 0', () => {
    expect(httpLabels('GET', '/health', 9999)['http.response.status_code']).toBe(0);
    expect(httpLabels('GET', '/health', 200.5)['http.response.status_code']).toBe(0);
  });
});

describe('buildInfoLabels', () => {
  it('labels by version only', () => {
    expect(buildInfoLabels('1.2.3')).toEqual({ version: '1.2.3' });
  });
});
