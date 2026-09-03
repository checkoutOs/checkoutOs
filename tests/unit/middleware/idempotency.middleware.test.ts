// tests/unit/middleware/idempotency.middleware.test.ts
// Unit tests for the idempotency middleware.
//
// The middleware does four things and nothing else (AGENTS.md §4.2): read the
// header, validate it, compute the request hash, attach it to req. It performs
// no Redis access and no service calls — those belong to the store and service
// layers respectively.
//
// Business invariants protected:
//   - A missing or malformed Idempotency-Key is rejected via next(err)
//   - The hash is scoped to the MOUNTED path, so one key cannot silently
//     collide across two root-mounted routers
//   - The query string does not participate in the hash
//   - Body key order does not participate in the hash

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { idempotencyMiddleware } from '../../../src/middleware/idempotency.middleware';
import {
  IdempotencyKeyMissingError,
  IdempotencyKeyInvalidError,
} from '../../../src/errors/idempotency.errors';

const KEY = '3f7d2a1e-1c4b-4f8a-9d2e-000000000001';

// Minimal Express request stand-in. baseUrl/path are the two fields the hash
// scoping depends on; Express populates them from the router mount.
function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    baseUrl: '/payments',
    path: '/',
    headers: { 'idempotency-key': KEY },
    body: { amount: 50000, currency: 'INR', orderId: 'order_1' },
    ...overrides,
  } as unknown as Request;
}

function run(req: Request): { next: NextFunction; error: unknown } {
  let error: unknown;
  const next = vi.fn((err?: unknown) => {
    error = err;
  }) as unknown as NextFunction;

  idempotencyMiddleware(req, {} as Response, next);

  return { next, error };
}

function hashOf(req: Request): string {
  run(req);
  return req.idempotency?.requestHash ?? '';
}

// ---------------------------------------------------------------------------
// Header validation
// ---------------------------------------------------------------------------

describe('idempotencyMiddleware — header validation', () => {
  it('rejects a missing header', () => {
    const { error } = run(makeRequest({ headers: {} }));

    expect(error).toBeInstanceOf(IdempotencyKeyMissingError);
  });

  it('rejects a blank header', () => {
    const { error } = run(makeRequest({ headers: { 'idempotency-key': '   ' } }));

    expect(error).toBeInstanceOf(IdempotencyKeyMissingError);
  });

  it('rejects a non-UUID header', () => {
    const { error } = run(makeRequest({ headers: { 'idempotency-key': 'not-a-uuid' } }));

    expect(error).toBeInstanceOf(IdempotencyKeyInvalidError);
  });

  it('attaches key and hash on success, calling next with no error', () => {
    const req = makeRequest();
    const { next, error } = run(req);

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
    expect(req.idempotency?.key).toBe(KEY);
    expect(req.idempotency?.requestHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Hash scoping — the mounted path, not the router-relative one
// ---------------------------------------------------------------------------

describe('idempotencyMiddleware — hash scoping', () => {
  it('scopes the hash to the mounted path, not the router-relative one', () => {
    // Both routers see req.path === '/'. If the hash used req.path alone, these
    // two unrelated endpoints would produce the same digest and one key could
    // silently collide across them.
    const payments = hashOf(makeRequest({ baseUrl: '/payments', path: '/' }));
    const refunds = hashOf(makeRequest({ baseUrl: '/refunds', path: '/' }));

    expect(payments).not.toBe(refunds);
  });

  it('separates sub-routes under the same mount', () => {
    const create = hashOf(makeRequest({ baseUrl: '/payments', path: '/' }));
    const refund = hashOf(makeRequest({ baseUrl: '/payments', path: '/chk_1/refund' }));

    expect(create).not.toBe(refund);
  });

  it('separates methods on the same path', () => {
    const post = hashOf(makeRequest({ method: 'POST' }));
    const put = hashOf(makeRequest({ method: 'PUT' }));

    expect(post).not.toBe(put);
  });

  it('ignores the query string', () => {
    // req.originalUrl would carry '?trace=1' and change the digest for a
    // request the handler treats identically.
    const plain = hashOf(makeRequest());
    const traced = hashOf(makeRequest({ url: '/?trace=1' } as Partial<Request>));

    expect(plain).toBe(traced);
  });

  it('treats a root-mounted route the same however the slash falls', () => {
    // '/payments' + '/' must normalise to the same input as a bare '/payments'.
    const mounted = hashOf(makeRequest({ baseUrl: '/payments', path: '/' }));
    const direct = hashOf(makeRequest({ baseUrl: '', path: '/payments' }));

    expect(mounted).toBe(direct);
  });
});

// ---------------------------------------------------------------------------
// Body handling
// ---------------------------------------------------------------------------

describe('idempotencyMiddleware — body hashing', () => {
  it('ignores JSON key order', () => {
    const a = hashOf(makeRequest({ body: { amount: 50000, orderId: 'o1' } }));
    const b = hashOf(makeRequest({ body: { orderId: 'o1', amount: 50000 } }));

    expect(a).toBe(b);
  });

  it('still separates genuinely different payloads', () => {
    const a = hashOf(makeRequest({ body: { amount: 50000, orderId: 'o1' } }));
    const b = hashOf(makeRequest({ body: { amount: 99900, orderId: 'o1' } }));

    expect(a).not.toBe(b);
  });
});
