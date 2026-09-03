// tests/unit/utils/hash.test.ts
// Unit tests for the idempotency request hash.
//
// The hash decides whether two requests carrying the same Idempotency-Key are
// "the same request". Hash too loosely and distinct payloads collide, letting a
// second request replay the first one's cached payment. Hash too strictly and a
// legitimate retry is refused with 400 IDEMPOTENCY_KEY_REUSED.
//
// Business invariants protected:
//   - Key order is NOT meaning: bodies differing only in key order match
//   - Array order IS meaning: reordered arrays must not match
//   - Distinct values, methods and paths still produce distinct hashes
//   - null / undefined / empty bodies are handled without collapsing together

import { describe, it, expect } from 'vitest';
import { generateRequestHash } from '../../../src/utils/hash';

const POST = 'POST';
const PATH = '/';

function hash(body: unknown, method = POST, path = PATH): string {
  return generateRequestHash(method, path, body);
}

// ---------------------------------------------------------------------------
// Key order must not change the hash
// ---------------------------------------------------------------------------

describe('generateRequestHash — key order independence', () => {
  it('hashes the same payload identically regardless of key order', () => {
    // The regression: JSON.stringify preserves insertion order, so these two
    // serialised differently and a re-serialising client was told its own
    // retry was a different request.
    const a = { amount: 50000, currency: 'INR', orderId: 'order_1' };
    const b = { orderId: 'order_1', currency: 'INR', amount: 50000 };

    expect(hash(a)).toBe(hash(b));
  });

  it('is stable for nested objects too', () => {
    const a = { orderId: 'o1', metadata: { source: 'web', campaign: 'diwali' } };
    const b = { metadata: { campaign: 'diwali', source: 'web' }, orderId: 'o1' };

    expect(hash(a)).toBe(hash(b));
  });

  it('is stable for objects nested inside arrays', () => {
    const a = { items: [{ sku: 'A', qty: 1 }] };
    const b = { items: [{ qty: 1, sku: 'A' }] };

    expect(hash(a)).toBe(hash(b));
  });

  it('produces the same digest across repeated calls', () => {
    const body = { amount: 50000, orderId: 'order_stable' };

    expect(hash(body)).toBe(hash(body));
  });
});

// ---------------------------------------------------------------------------
// Array order IS significant
// ---------------------------------------------------------------------------

describe('generateRequestHash — array order significance', () => {
  it('treats reordered arrays as different requests', () => {
    // Position carries meaning in an array, unlike key position in an object.
    expect(hash({ items: ['a', 'b'] })).not.toBe(hash({ items: ['b', 'a'] }));
  });

  it('distinguishes an array from an object with numeric keys', () => {
    expect(hash({ items: ['a'] })).not.toBe(hash({ items: { 0: 'a' } }));
  });
});

// ---------------------------------------------------------------------------
// Different requests must stay different
// ---------------------------------------------------------------------------

describe('generateRequestHash — discrimination', () => {
  it('separates different amounts', () => {
    expect(hash({ amount: 50000 })).not.toBe(hash({ amount: 50001 }));
  });

  it('separates a string value from the numeric one', () => {
    expect(hash({ amount: 50000 })).not.toBe(hash({ amount: '50000' }));
  });

  it('separates different methods', () => {
    const body = { amount: 50000 };

    expect(hash(body, 'POST')).not.toBe(hash(body, 'PUT'));
  });

  it('separates different paths', () => {
    const body = { amount: 50000 };

    expect(hash(body, POST, '/payments')).not.toBe(hash(body, POST, '/refunds'));
  });

  it('separates an extra field from its absence', () => {
    expect(hash({ amount: 50000 })).not.toBe(hash({ amount: 50000, description: 'x' }));
  });
});

// ---------------------------------------------------------------------------
// Edge values
// ---------------------------------------------------------------------------

describe('generateRequestHash — edge values', () => {
  it('does not treat null as an object to be walked', () => {
    expect(() => hash({ description: null })).not.toThrow();
    expect(hash({ description: null })).not.toBe(hash({ description: {} }));
  });

  it('drops undefined properties, matching JSON.stringify', () => {
    expect(hash({ amount: 50000, description: undefined })).toBe(hash({ amount: 50000 }));
  });

  it('distinguishes an explicit null from an absent field', () => {
    expect(hash({ amount: 50000, description: null })).not.toBe(hash({ amount: 50000 }));
  });

  it('handles an undefined body without throwing', () => {
    expect(() => hash(undefined)).not.toThrow();
    expect(hash(undefined)).toHaveLength(64);
  });

  it('distinguishes an empty object body from an undefined body', () => {
    expect(hash({})).not.toBe(hash(undefined));
  });

  it('converts values via toJSON instead of flattening them to {}', () => {
    // Without the toJSON branch every Date canonicalises to {} — two different
    // timestamps would hash identically.
    const early = new Date('2026-01-01T00:00:00.000Z');
    const late = new Date('2026-06-01T00:00:00.000Z');

    expect(hash({ at: early })).not.toBe(hash({ at: late }));
    expect(hash({ at: early })).toBe(hash({ at: new Date('2026-01-01T00:00:00.000Z') }));
  });

  it('returns a 64-character hex digest', () => {
    expect(hash({ amount: 50000 })).toMatch(/^[a-f0-9]{64}$/);
  });
});
