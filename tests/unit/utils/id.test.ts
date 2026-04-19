// tests/unit/utils/id.test.ts
// Tests for ID generation and validation utilities.
//
// Business invariants protected:
//   - Payment IDs always start with chk_ and have exactly 32 hex chars after
//   - Refund IDs always start with ref_ and have exactly 32 hex chars after
//   - Every generated ID is unique
//   - Validators correctly identify valid and invalid IDs

import { describe, it, expect } from 'vitest';
import {
  generatePaymentId,
  generateRefundId,
  isValidPaymentId,
  isValidRefundId,
  PAYMENT_ID_PREFIX,
  REFUND_ID_PREFIX,
} from '../../../src/utils/id';

// ---------------------------------------------------------------------------
// generatePaymentId
// ---------------------------------------------------------------------------

describe('generatePaymentId', () => {
  it('returns a string starting with chk_', () => {
    const id = generatePaymentId();
    expect(id.startsWith(PAYMENT_ID_PREFIX)).toBe(true);
  });

  it('returns a string with exactly 32 hex characters after the prefix', () => {
    const id = generatePaymentId();
    const suffix = id.slice(PAYMENT_ID_PREFIX.length);
    expect(suffix).toHaveLength(32);
    expect(/^[a-f0-9]{32}$/.test(suffix)).toBe(true);
  });

  it('generates unique IDs on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generatePaymentId()));
    // All 100 generated IDs should be unique
    expect(ids.size).toBe(100);
  });

  it('total length is prefix length + 32', () => {
    const id = generatePaymentId();
    expect(id).toHaveLength(PAYMENT_ID_PREFIX.length + 32);
  });
});

// ---------------------------------------------------------------------------
// generateRefundId
// ---------------------------------------------------------------------------

describe('generateRefundId', () => {
  it('returns a string starting with ref_', () => {
    const id = generateRefundId();
    expect(id.startsWith(REFUND_ID_PREFIX)).toBe(true);
  });

  it('returns a string with exactly 32 hex characters after the prefix', () => {
    const id = generateRefundId();
    const suffix = id.slice(REFUND_ID_PREFIX.length);
    expect(suffix).toHaveLength(32);
    expect(/^[a-f0-9]{32}$/.test(suffix)).toBe(true);
  });

  it('generates unique IDs on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRefundId()));
    expect(ids.size).toBe(100);
  });

  it('payment and refund IDs are never equal', () => {
    // Different prefixes guarantee they can never collide
    const payId = generatePaymentId();
    const refId = generateRefundId();
    expect(payId).not.toBe(refId);
    expect(payId.startsWith('chk_')).toBe(true);
    expect(refId.startsWith('ref_')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isValidPaymentId
// ---------------------------------------------------------------------------

describe('isValidPaymentId', () => {
  it('returns true for a correctly generated payment ID', () => {
    const id = generatePaymentId();
    expect(isValidPaymentId(id)).toBe(true);
  });

  it('returns false for a refund ID', () => {
    const id = generateRefundId();
    expect(isValidPaymentId(id)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isValidPaymentId('')).toBe(false);
  });

  it('returns false for chk_ prefix with wrong suffix length', () => {
    expect(isValidPaymentId('chk_abc123')).toBe(false);
  });

  it('returns false for a plain UUID without prefix', () => {
    expect(isValidPaymentId('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(false);
  });

  it('returns false for non-string input', () => {
    // @ts-expect-error — testing runtime behaviour with wrong type
    expect(isValidPaymentId(null)).toBe(false);
    // @ts-expect-error
    expect(isValidPaymentId(undefined)).toBe(false);
    // @ts-expect-error
    expect(isValidPaymentId(123)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidRefundId
// ---------------------------------------------------------------------------

describe('isValidRefundId', () => {
  it('returns true for a correctly generated refund ID', () => {
    const id = generateRefundId();
    expect(isValidRefundId(id)).toBe(true);
  });

  it('returns false for a payment ID', () => {
    const id = generatePaymentId();
    expect(isValidRefundId(id)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isValidRefundId('')).toBe(false);
  });

  it('returns false for ref_ prefix with wrong suffix length', () => {
    expect(isValidRefundId('ref_abc123')).toBe(false);
  });

  it('returns false for non-string input', () => {
    // @ts-expect-error
    expect(isValidRefundId(null)).toBe(false);
    // @ts-expect-error
    expect(isValidRefundId(undefined)).toBe(false);
  });
});
