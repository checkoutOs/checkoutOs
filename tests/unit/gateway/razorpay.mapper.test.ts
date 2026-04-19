// tests/unit/gateway/razorpay.mapper.test.ts
// Tests for RazorpayMapper — the most critical test in the suite.
//
// Business invariants protected:
//   - Every Razorpay-native status string maps to exactly the correct
//     unified PaymentStatus or RefundStatus
//   - Unknown status strings ALWAYS throw GatewayMappingError — never silent
//   - toPaymentResult() produces correct GatewayPaymentResult shape
//   - toRefundResult() produces correct GatewayRefundResult shape
//   - paymentUrl is never set by the mapper (requires credentials)
//
// A wrong mapping here corrupts Redis payment state silently.
// These tests are the first line of defence against that.

import { describe, it, expect } from 'vitest';
import { RazorpayMapper } from '../../../src/gateways/razorpay/razorpay.mapper';
import { GatewayMappingError } from '../../../src/errors';
import { PaymentStatus, RefundStatus } from '../../../src/types/payment.types';
import type {
  RazorpayPayment,
  RazorpayRefund,
} from '../../../src/gateways/razorpay/razorpay.types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const mockRazorpayPayment: RazorpayPayment = {
  id: 'pay_mockPayment001',
  entity: 'payment',
  amount: 50000,
  currency: 'INR',
  status: 'captured',
  order_id: 'order_mock001',
  created_at: 1705314600,
};

const mockRazorpayRefund: RazorpayRefund = {
  id: 'rfnd_mockRefund001',
  entity: 'refund',
  amount: 50000,
  currency: 'INR',
  payment_id: 'pay_mockPayment001',
  status: 'processed',
  created_at: 1705314600,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mapper = new RazorpayMapper();

// ---------------------------------------------------------------------------
// toUnifiedStatus — payment status mapping
// ---------------------------------------------------------------------------

describe('RazorpayMapper.toUnifiedStatus', () => {
  // --- PENDING mappings ---
  it('maps "created" to PENDING', () => {
    expect(mapper.toUnifiedStatus('created')).toBe(PaymentStatus.PENDING);
  });

  it('maps "attempted" to PENDING', () => {
    expect(mapper.toUnifiedStatus('attempted')).toBe(PaymentStatus.PENDING);
  });

  it('maps "pending" to PENDING', () => {
    expect(mapper.toUnifiedStatus('pending')).toBe(PaymentStatus.PENDING);
  });

  // --- PROCESSING mappings ---
  it('maps "authorized" to PROCESSING', () => {
    expect(mapper.toUnifiedStatus('authorized')).toBe(PaymentStatus.PROCESSING);
  });

  it('maps "processing" to PROCESSING', () => {
    expect(mapper.toUnifiedStatus('processing')).toBe(PaymentStatus.PROCESSING);
  });

  // --- SUCCESS mappings ---
  it('maps "captured" to SUCCESS', () => {
    expect(mapper.toUnifiedStatus('captured')).toBe(PaymentStatus.SUCCESS);
  });

  it('maps "paid" to SUCCESS', () => {
    expect(mapper.toUnifiedStatus('paid')).toBe(PaymentStatus.SUCCESS);
  });

  // --- FAILED mappings ---
  it('maps "failed" to FAILED', () => {
    expect(mapper.toUnifiedStatus('failed')).toBe(PaymentStatus.FAILED);
  });

  // --- REFUNDED mappings ---
  it('maps "refunded" to REFUNDED', () => {
    expect(mapper.toUnifiedStatus('refunded')).toBe(PaymentStatus.REFUNDED);
  });

  // --- PARTIALLY_REFUNDED mappings ---
  it('maps "partially_refunded" to PARTIALLY_REFUNDED', () => {
    expect(mapper.toUnifiedStatus('partially_refunded')).toBe(PaymentStatus.PARTIALLY_REFUNDED);
  });

  it('maps "partial_refunded" to PARTIALLY_REFUNDED', () => {
    expect(mapper.toUnifiedStatus('partial_refunded')).toBe(PaymentStatus.PARTIALLY_REFUNDED);
  });

  // --- CANCELLED mappings ---
  it('maps "cancelled" to CANCELLED', () => {
    expect(mapper.toUnifiedStatus('cancelled')).toBe(PaymentStatus.CANCELLED);
  });

  it('maps "canceled" (US spelling) to CANCELLED', () => {
    expect(mapper.toUnifiedStatus('canceled')).toBe(PaymentStatus.CANCELLED);
  });

  // --- EXPIRED mappings ---
  it('maps "expired" to EXPIRED', () => {
    expect(mapper.toUnifiedStatus('expired')).toBe(PaymentStatus.EXPIRED);
  });

  // --- Unknown status — must throw, never fallback ---
  it('throws GatewayMappingError for an unknown status string', () => {
    expect(() => mapper.toUnifiedStatus('on_hold')).toThrow(GatewayMappingError);
  });

  it('throws GatewayMappingError for an empty string', () => {
    expect(() => mapper.toUnifiedStatus('')).toThrow(GatewayMappingError);
  });

  it('throws GatewayMappingError for a future unknown status', () => {
    expect(() => mapper.toUnifiedStatus('disputed')).toThrow(GatewayMappingError);
  });

  it('GatewayMappingError message includes the unknown status string', () => {
    try {
      mapper.toUnifiedStatus('unknown_future_status');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayMappingError);
      expect((err as GatewayMappingError).message).toContain('unknown_future_status');
    }
  });

  it('does NOT return PROCESSING as a fallback for unknown status', () => {
    expect(() => mapper.toUnifiedStatus('some_new_status')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// toUnifiedRefundStatus — refund status mapping
// ---------------------------------------------------------------------------

describe('RazorpayMapper.toUnifiedRefundStatus', () => {
  it('maps "pending" to RefundStatus.PENDING', () => {
    expect(mapper.toUnifiedRefundStatus('pending')).toBe(RefundStatus.PENDING);
  });

  it('maps "processing" to RefundStatus.PROCESSING', () => {
    expect(mapper.toUnifiedRefundStatus('processing')).toBe(RefundStatus.PROCESSING);
  });

  it('maps "processed" to RefundStatus.SUCCESS', () => {
    expect(mapper.toUnifiedRefundStatus('processed')).toBe(RefundStatus.SUCCESS);
  });

  it('maps "failed" to RefundStatus.FAILED', () => {
    expect(mapper.toUnifiedRefundStatus('failed')).toBe(RefundStatus.FAILED);
  });

  it('throws GatewayMappingError for unknown refund status', () => {
    expect(() => mapper.toUnifiedRefundStatus('reversed')).toThrow(GatewayMappingError);
  });

  it('throws GatewayMappingError for empty string', () => {
    expect(() => mapper.toUnifiedRefundStatus('')).toThrow(GatewayMappingError);
  });

  it('does NOT accept payment status strings as refund statuses', () => {
    expect(() => mapper.toUnifiedRefundStatus('captured')).toThrow(GatewayMappingError);
  });

  it('throws GatewayMappingError for a truly unsupported status string', () => {
    expect(() => mapper.toUnifiedRefundStatus('unknown_refund_status_xyz')).toThrow(
      GatewayMappingError,
    );
  });
});

// ---------------------------------------------------------------------------
// toPaymentResult
// ---------------------------------------------------------------------------

describe('RazorpayMapper.toPaymentResult', () => {
  it('maps raw RazorpayPayment to GatewayPaymentResult', () => {
    const result = mapper.toPaymentResult(mockRazorpayPayment);

    expect(result.gatewayId).toBe('pay_mockPayment001');
    expect(result.status).toBe(PaymentStatus.SUCCESS);
    expect(result.amount).toBe(50000);
    expect(result.currency).toBe('INR');
    expect(result.gatewayOrderId).toBe('order_mock001');
  });

  it('preserves the raw response in the raw field', () => {
    const result = mapper.toPaymentResult(mockRazorpayPayment);
    expect(result.raw).toBe(mockRazorpayPayment);
  });

  it('does NOT set paymentUrl — credentials are not available in mapper', () => {
    const result = mapper.toPaymentResult(mockRazorpayPayment);
    expect(result.paymentUrl).toBeUndefined();
  });

  it('correctly maps all payment statuses through toPaymentResult', () => {
    const statuses: Array<[RazorpayPayment['status'], PaymentStatus]> = [
      ['created', PaymentStatus.PENDING],
      ['authorized', PaymentStatus.PROCESSING],
      ['captured', PaymentStatus.SUCCESS],
      ['failed', PaymentStatus.FAILED],
      ['refunded', PaymentStatus.REFUNDED],
    ];

    for (const [razorpayStatus, expectedStatus] of statuses) {
      const raw: RazorpayPayment = { ...mockRazorpayPayment, status: razorpayStatus };
      const result = mapper.toPaymentResult(raw);
      expect(result.status).toBe(expectedStatus);
    }
  });
});

// ---------------------------------------------------------------------------
// toRefundResult
// ---------------------------------------------------------------------------

describe('RazorpayMapper.toRefundResult', () => {
  it('maps raw RazorpayRefund to GatewayRefundResult', () => {
    const result = mapper.toRefundResult(mockRazorpayRefund);

    expect(result.gatewayRefundId).toBe('rfnd_mockRefund001');
    expect(result.gatewayPaymentId).toBe('pay_mockPayment001');
    expect(result.status).toBe(RefundStatus.SUCCESS);
    expect(result.amount).toBe(50000);
    expect(result.currency).toBe('INR');
  });

  it('preserves the raw response in the raw field', () => {
    const result = mapper.toRefundResult(mockRazorpayRefund);
    expect(result.raw).toBe(mockRazorpayRefund);
  });

  it('correctly maps all refund statuses through toRefundResult', () => {
    const statuses: Array<[RazorpayRefund['status'], RefundStatus]> = [
      ['pending', RefundStatus.PENDING],
      ['processed', RefundStatus.SUCCESS],
      ['failed', RefundStatus.FAILED],
    ];

    for (const [razorpayStatus, expectedStatus] of statuses) {
      const raw: RazorpayRefund = { ...mockRazorpayRefund, status: razorpayStatus };
      const result = mapper.toRefundResult(raw);
      expect(result.status).toBe(expectedStatus);
    }
  });
});
