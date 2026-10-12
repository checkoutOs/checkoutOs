// metrics.server.ts
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

export interface MetricsServerOptions {
  port: number;
  authToken: string | undefined;
  exporter: PrometheusExporter;
}

export interface MetricsServer {
  readonly port: number;
  // Resolves once listening; rejects on a bind failure (e.g. EADDRINUSE).
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

const METRICS_PATH = '/metrics';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// Constant-time comparison. Hashing both sides first gives equal-length
// buffers, so neither the content nor the length of the token leaks through
// timing. This is the only auth check in the codebase and it guards payment
// volumes and revenue shape.
export function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (token === undefined) {
    return true;
  }
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}

export function startMetricsServer(options: MetricsServerOptions): MetricsServer {
  const server = http.createServer((req, res): void => {
    // Auth before routing, so an unauthenticated caller learns nothing.
    if (!isAuthorized(req.headers.authorization, options.authToken)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }

    const path = (req.url ?? '').split('?')[0];
    if (path !== METRICS_PATH) {
      res.writeHead(404).end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    options.exporter.getMetricsRequestHandler(req, res);
  });

  const ready = new Promise<void>((resolve, reject): void => {
    server.once('listening', (): void => resolve());
    server.once('error', reject);
  });
  // Observed here so a bind failure never surfaces as an unhandled rejection
  // when no caller awaits `ready` (verifyTelemetry is the one that reports it).
  ready.catch((): void => undefined);

  server.listen(options.port);

  return {
    port: options.port,
    ready,
    stop(): Promise<void> {
      return new Promise<void>((resolve): void => {
        if (!server.listening) {
          resolve();
          return;
        }
        // Scrapers hold keep-alive connections; close() alone would wait on them.
        server.close((): void => resolve());
        server.closeAllConnections();
      });
    },
  };
}
