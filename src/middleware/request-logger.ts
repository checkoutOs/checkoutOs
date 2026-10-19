// request-logger.ts
// Logs one http.request.completed record per request, when the response
// finishes. Mounted first in buildApp() so it captures every request,
// including those that fail early.
//
// Log level follows HTTP status: 5xx → error, 4xx → warn, 2xx/3xx → info.
//
// Logs only — no metrics. The HTTP duration histogram is emitted by
// HttpInstrumentation (http.server.request.duration, stable semconv labels
// http.route / http.request.method / http.response.status_code). Never define
// a second one here: two families with the same name make Prometheus reject
// the whole scrape (ADR 003 §5 Phase 2b). scripts/verify-telemetry.mjs fails
// if one appears.

import type { Request, Response, NextFunction } from 'express';
import { createContextLogger } from '../utils/logger';

const log = createContextLogger('request-logger');

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  // route is the bounded pattern ('/payments/:chkId'), never the raw path —
  // the same cardinality rule as the metric's http_route label.
  // It cannot be read at 'finish': req.route.path is relative to the mount
  // ('/:chkId'), and when a handler fails via next(err) Express has already
  // reset req.baseUrl to '' by then. So capture baseUrl + route.path at the
  // moment Express assigns req.route, while baseUrl is still the mount path.
  // Absent when nothing matched (404 from notFoundHandler).
  let route: string | undefined;
  let current: unknown;
  Object.defineProperty(req, 'route', {
    configurable: true,
    enumerable: true,
    get: (): unknown => current,
    set: (value: unknown): void => {
      current = value;
      const pattern = (value as { path?: unknown } | undefined)?.path;
      if (typeof pattern === 'string') {
        route = `${req.baseUrl}${pattern}`.replace(/(.)\/$/, '$1');
      }
    },
  });

  res.on('finish', (): void => {
    const latencyMs = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    // By 'finish', a mounted router has rewritten req.path ('/health' → '/'),
    // so the real path comes from originalUrl (query string dropped).
    const path = req.originalUrl.split('?')[0];

    log[level]('http.request.completed', {
      method: req.method,
      path,
      ...(route !== undefined && { route }),
      statusCode: res.statusCode,
      latencyMs,
    });
  });

  next();
}
