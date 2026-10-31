// tests/unit/middleware/request-logger.test.ts
// Unit tests for requestLogger — one http.request.completed record per request.
//
// Business invariants protected:
//   - route is the full bounded pattern ('/payments/:chkId'), the same value
//     as the metric's http_route label — including when the handler fails via
//     next(err), where Express has already reset req.baseUrl by 'finish'
//   - route is absent when nothing matched (no raw path leaks into it)
//   - path comes from originalUrl, without the query string — a mounted
//     router has rewritten req.path to '/' by 'finish'
//   - level follows status: 2xx/3xx info, 4xx warn, 5xx error

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import winston from 'winston';
import { logger, configureLogger } from '../../../src/utils/logger';
import { requestLogger } from '../../../src/middleware/request-logger';

interface Record {
  event: string;
  component: string;
  level: string;
  method: string;
  path: string;
  route?: string;
  statusCode: number;
  latencyMs: number;
}

let records: Record[];
let sink: winston.transport;
let original: winston.transport[];

beforeEach(() => {
  records = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      records.push(JSON.parse(line) as Record);
    }
  });
  original = [...logger.transports];
  sink = new winston.transports.Stream({ stream });
  logger.clear();
  logger.add(sink);
  configureLogger({ isTest: false, isDevelopment: false, format: 'json' });
});

afterEach(() => {
  logger.remove(sink);
  for (const transport of original) logger.add(transport);
  configureLogger({ isTest: true, isDevelopment: false });
});

function buildApp(): express.Application {
  const app = express();
  app.use(requestLogger);

  const payments = Router();
  payments.get('/:chkId', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });
  payments.get('/:chkId/fail', (_req: Request, _res: Response, next: NextFunction) => {
    next(new Error('boom'));
  });
  payments.get('/:chkId/missing', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });
  app.use('/payments', payments);

  const health = Router();
  health.get('/', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });
  app.use('/health', health);

  app.use((_req: Request, res: Response) => {
    res.status(404).end();
  });
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).end();
  });
  return app;
}

async function only(): Promise<Record> {
  // 'finish' fires as the response is flushed; give the listener a tick.
  await new Promise((done) => setImmediate(done));
  expect(records).toHaveLength(1);
  return records[0]!;
}

describe('requestLogger', () => {
  it('logs the full route pattern and the real path for a mounted router', async () => {
    await request(buildApp()).get('/payments/chk_abc123?verbose=1');
    const record = await only();

    expect(record).toMatchObject({
      event: 'http.request.completed',
      component: 'request-logger',
      level: 'info',
      method: 'GET',
      path: '/payments/chk_abc123',
      route: '/payments/:chkId',
      statusCode: 200,
    });
    expect(typeof record.latencyMs).toBe('number');
  });

  it('trims the trailing slash of a router mounted at its root', async () => {
    await request(buildApp()).get('/health');
    const record = await only();

    expect(record.path).toBe('/health');
    expect(record.route).toBe('/health');
  });

  it('keeps the full route when the handler fails via next(err)', async () => {
    await request(buildApp()).get('/payments/chk_abc123/fail');
    const record = await only();

    expect(record.level).toBe('error');
    expect(record.statusCode).toBe(500);
    expect(record.route).toBe('/payments/:chkId/fail');
  });

  it('logs 4xx at warn', async () => {
    await request(buildApp()).get('/payments/chk_abc123/missing');
    const record = await only();

    expect(record.level).toBe('warn');
    expect(record.route).toBe('/payments/:chkId/missing');
  });

  it('omits route when nothing matched — never falls back to the raw path', async () => {
    await request(buildApp()).get('/nope/chk_abc123');
    const record = await only();

    expect(record.statusCode).toBe(404);
    expect(record.path).toBe('/nope/chk_abc123');
    expect(record).not.toHaveProperty('route');
  });
});
