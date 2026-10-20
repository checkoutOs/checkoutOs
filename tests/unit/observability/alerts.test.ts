// tests/unit/observability/alerts.test.ts
// Static checks on the alert rules and dashboards in observability/.
// (Rule BEHAVIOUR is tested by promtool: observability/prometheus/alerts.test.yml.)
//
// Business invariants protected:
//   - every latency threshold — alerts AND dashboard threshold lines — sits on
//     a bucket boundary of that histogram (ADR 003 §5 Phase 2d).
//     histogram_quantile() interpolates linearly inside a bucket, so a
//     threshold between two boundaries reports a guess.
//   - every alert has at least one promtool test
//   - every checkoutos_* metric an alert or dashboard queries is in
//     docs/metrics.md — a typo there is a panel that silently shows "No data"

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  GATEWAY_REQUEST_BUCKETS,
  HTTP_SERVER_BUCKETS,
  WEBHOOK_PROCESSING_BUCKETS,
  WEBHOOK_RELAY_BUCKETS,
} from '../../../src/telemetry/buckets';

const ROOT = resolve(__dirname, '../../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf-8');

const ALERTS = read('observability/prometheus/alerts.yml');
const ALERT_TESTS = read('observability/prometheus/alerts.test.yml');
const METRICS_DOC = read('docs/metrics.md');
const DASHBOARD_DIR = 'observability/grafana/dashboards';
const DASHBOARDS = readdirSync(join(ROOT, DASHBOARD_DIR))
  .filter((file) => file.endsWith('.json'))
  .map((file) => ({ file, json: read(`${DASHBOARD_DIR}/${file}`) }));

const BUCKETS: Record<string, readonly number[]> = {
  checkoutos_gateway_request_duration: GATEWAY_REQUEST_BUCKETS,
  checkoutos_http_server_request_duration: HTTP_SERVER_BUCKETS,
  checkoutos_webhook_processing_duration: WEBHOOK_PROCESSING_BUCKETS,
  checkoutos_webhook_relay_duration: WEBHOOK_RELAY_BUCKETS,
};

// `histogram_quantile(q, ... <metric>_bucket ...) > <threshold>`
function alertQuantileThresholds(): { metric: string; threshold: number }[] {
  const found: { metric: string; threshold: number }[] = [];
  for (const match of ALERTS.matchAll(
    /histogram_quantile\([\s\S]*?(checkoutos_\w+?)_bucket[\s\S]*?\)\s*\)\s*>\s*([\d.]+)/g,
  )) {
    found.push({ metric: match[1]!, threshold: Number(match[2]) });
  }
  return found;
}

interface Panel {
  title?: string;
  targets?: { expr?: string }[];
  fieldConfig?: { defaults?: { thresholds?: { steps?: { value: number | null }[] } } };
  panels?: Panel[];
}

function panels(json: string): Panel[] {
  const flat: Panel[] = [];
  const walk = (list: Panel[] = []): void => {
    for (const panel of list) {
      flat.push(panel);
      walk(panel.panels);
    }
  };
  walk((JSON.parse(json) as { panels: Panel[] }).panels);
  return flat;
}

describe('alert rules', () => {
  it('put every latency threshold on a bucket boundary', () => {
    const thresholds = alertQuantileThresholds();

    expect(thresholds.length).toBeGreaterThan(0);
    for (const { metric, threshold } of thresholds) {
      expect(BUCKETS[metric], `${metric} has no known buckets`).toBeDefined();
      expect(BUCKETS[metric], `${metric} > ${threshold}`).toContain(threshold);
    }
  });

  it('pin the 8s gateway latency alert (ADR 003 §10.2)', () => {
    expect(alertQuantileThresholds()).toContainEqual({
      metric: 'checkoutos_gateway_request_duration',
      threshold: 8,
    });
  });

  it('each have a promtool test', () => {
    const alerts = [...ALERTS.matchAll(/- alert: (\w+)/g)].map((m) => m[1]!);
    const tested = new Set([...ALERT_TESTS.matchAll(/alertname: (\w+)/g)].map((m) => m[1]!));

    expect(alerts.length).toBe(7);
    expect(alerts.filter((alert) => !tested.has(alert))).toEqual([]);
  });
});

describe('dashboards', () => {
  it('exist for overview, gateways, webhooks and idempotency', () => {
    expect(DASHBOARDS.map(({ file }) => file).sort()).toEqual([
      'checkoutos-gateways.json',
      'checkoutos-idempotency.json',
      'checkoutos-overview.json',
      'checkoutos-webhooks.json',
    ]);
  });

  it('put every latency threshold line on a bucket boundary', () => {
    let checked = 0;
    for (const { file, json } of DASHBOARDS) {
      for (const panel of panels(json)) {
        const expr = panel.targets?.map((t) => t.expr ?? '').join(' ') ?? '';
        const metric = /histogram_quantile\([\s\S]*?(checkoutos_\w+?)_bucket/.exec(expr)?.[1];
        const steps = panel.fieldConfig?.defaults?.thresholds?.steps ?? [];
        if (metric === undefined) continue;
        for (const { value } of steps) {
          if (value === null) continue;
          checked += 1;
          expect(BUCKETS[metric], `${file} "${panel.title}" line at ${value}`).toContain(value);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('metric names', () => {
  // Families documented in docs/metrics.md, e.g. `checkoutos_payments_created_total`.
  const documented = new Set(
    [...METRICS_DOC.matchAll(/`(checkoutos_\w+|target_info)`/g)].map((m) => m[1]!),
  );
  const family = (series: string): string => series.replace(/_(bucket|count|sum)$/, '');

  it.each([
    ['alerts.yml', ALERTS],
    ...DASHBOARDS.map(({ file, json }): [string, string] => [file, json]),
  ])('%s queries only documented metrics', (_file, text) => {
    const used = [...text.matchAll(/\b(checkoutos_\w+)/g)].map((m) => family(m[1]!));

    expect(used.length).toBeGreaterThan(0);
    expect([...new Set(used)].filter((name) => !documented.has(name))).toEqual([]);
  });
});
