// tests/unit/gateways/paytm/paytm.mapper.test.ts
// Tests for PaytmMapper — critical status mapping validation.
//
// Business invariants protected:
//   - Every Paytm STATUS + RESPCODE combination maps correctly per Integration Plan §6
//   - Unknown STATUS or RESPCODE ALWAYS throws GatewayMappingError — never silent fallback
//   - TXN_SUCCESS always maps to SUCCESS regardless of RESPCODE
//   - TXN_FAILURE always maps to FAILED regardless of RESPCODE
//   - PENDING is sub-classified by RESPCODE into FAILED, CANCELLED, EXPIRED, or PROCESSING
//   - Refund states map correctly to unified RefundStatus
//   - Amount conversion: rupees string → paise integer (and back)
//
// A wrong mapping here corrupts Redis payment state silently.
// These tests are the first line of defence against that.

import { describe, it, expect } from 'vitest';
import { PaytmMapper } from '../../../src/gateways/paytm/paytm.mapper';
import { GatewayMappingError } from '../../../src/errors';
import { PaymentStatus, RefundStatus } from '../../../src/types/payment.types';
import type {
  PaytmTransactionStatusResponse,
  PaytmRefundResponse,
} from '../../../src/gateways/paytm/paytm.types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const mockTransactionStatusResponse: PaytmTransactionStatusResponse = {
  head: {},
  body: {
    txnId: '20240115111212800110168234501612345',
    orderId: 'ORDER_001',
    txnAmount: '500.00',
    currency: 'INR',
    status: 'TXN_SUCCESS',
    respCode: '01',
    respMsg: 'Txn Success',
    resultInfo: {
      resultStatus: 'S',
      resultCode: '01',
      resultMsg: 'Success',
    },
  },
};

const mockRefundResponse: PaytmRefundResponse = {
  head: {},
  body: {
    refundId: 'REFUND_001',
    txnId: '20240115111212800110168234501612345',
    orderId: 'ORDER_001',
    refundAmount: '500.00',
    currency: 'INR',
    status: 'SUCCESS',
    resultInfo: {
      resultStatus: 'S',
      resultCode: '01',
      resultMsg: 'Success',
    },
  },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mapper = new PaytmMapper();

// ===========================================================================
// toUnifiedStatus — single-string STATUS mapping
// ===========================================================================

describe('PaytmMapper.toUnifiedStatus', () => {
  // ── TXN_SUCCESS → SUCCESS ─────────────────────────────────────────────
  it('maps TXN_SUCCESS to SUCCESS', () => {
    expect(mapper.toUnifiedStatus('TXN_SUCCESS')).toBe(PaymentStatus.SUCCESS);
  });

  // ── TXN_FAILURE → FAILED ──────────────────────────────────────────────
  it('maps TXN_FAILURE to FAILED', () => {
    expect(mapper.toUnifiedStatus('TXN_FAILURE')).toBe(PaymentStatus.FAILED);
  });

  // ── PENDING → PROCESSING (default when RESPCODE is unknown) ───────────
  it('maps PENDING to PROCESSING (default for polling without RESPCODE)', () => {
    expect(mapper.toUnifiedStatus('PENDING')).toBe(PaymentStatus.PROCESSING);
  });

  // ── Unknown STATUS → throw ────────────────────────────────────────────
  it('throws GatewayMappingError for unknown status string', () => {
    expect(() => mapper.toUnifiedStatus('UNKNOWN_STATUS')).toThrow(GatewayMappingError);
  });

  it('throws GatewayMappingError for empty string', () => {
    expect(() => mapper.toUnifiedStatus('')).toThrow(GatewayMappingError);
  });

  it('GatewayMappingError message includes the unknown status', () => {
    try {
      mapper.toUnifiedStatus('INVALID_STATUS');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayMappingError);
      expect((err as GatewayMappingError).message).toContain('INVALID_STATUS');
    }
  });
});

// ===========================================================================
// toUnifiedRefundStatus — refund state mapping
// ===========================================================================

describe('PaytmMapper.toUnifiedRefundStatus', () => {
  it('maps ACCEPTED to RefundStatus.PENDING', () => {
    expect(mapper.toUnifiedRefundStatus('ACCEPTED')).toBe(RefundStatus.PENDING);
  });

  it('maps PENDING to RefundStatus.PROCESSING', () => {
    expect(mapper.toUnifiedRefundStatus('PENDING')).toBe(RefundStatus.PROCESSING);
  });

  it('maps SUCCESS to RefundStatus.SUCCESS', () => {
    expect(mapper.toUnifiedRefundStatus('SUCCESS')).toBe(RefundStatus.SUCCESS);
  });

  it('maps FAILED to RefundStatus.FAILED', () => {
    expect(mapper.toUnifiedRefundStatus('FAILED')).toBe(RefundStatus.FAILED);
  });

  it('maps REVERSED to RefundStatus.FAILED', () => {
    expect(mapper.toUnifiedRefundStatus('REVERSED')).toBe(RefundStatus.FAILED);
  });

  it('throws GatewayMappingError for unknown refund status', () => {
    expect(() => mapper.toUnifiedRefundStatus('UNKNOWN_REFUND_STATE')).toThrow(GatewayMappingError);
  });

  it('throws GatewayMappingError for empty string', () => {
    expect(() => mapper.toUnifiedRefundStatus('')).toThrow(GatewayMappingError);
  });
});

// ===========================================================================
// mapWebhookToPaymentStatus — complete STATUS + RESPCODE matrix (§6)
// ===========================================================================

describe('PaytmMapper.mapWebhookToPaymentStatus', () => {
  // ── §6.1: Always-terminal STATUS ──────────────────────────────────────
  describe('TXN_SUCCESS (always SUCCESS)', () => {
    it('maps TXN_SUCCESS with any RESPCODE to SUCCESS', () => {
      expect(mapper.mapWebhookToPaymentStatus('TXN_SUCCESS', '01')).toBe(PaymentStatus.SUCCESS);
      expect(mapper.mapWebhookToPaymentStatus('TXN_SUCCESS', '')).toBe(PaymentStatus.SUCCESS);
      expect(mapper.mapWebhookToPaymentStatus('TXN_SUCCESS', '999')).toBe(PaymentStatus.SUCCESS);
    });
  });

  describe('TXN_FAILURE (always FAILED)', () => {
    it('maps TXN_FAILURE with any RESPCODE to FAILED', () => {
      expect(mapper.mapWebhookToPaymentStatus('TXN_FAILURE', '227')).toBe(PaymentStatus.FAILED);
      expect(mapper.mapWebhookToPaymentStatus('TXN_FAILURE', '')).toBe(PaymentStatus.FAILED);
      expect(mapper.mapWebhookToPaymentStatus('TXN_FAILURE', '810')).toBe(PaymentStatus.FAILED);
    });
  });

  // ── §6.2: PENDING + bank failure RESPCODE → FAILED ────────────────────
  describe('PENDING + bank failure RESPCODE → FAILED', () => {
    const bankFailureCodes = ['227', '228', '229', '230', '400', '401', '402', '403', '404', '810'];

    for (const code of bankFailureCodes) {
      it(`maps PENDING + RESPCODE=${code} to FAILED`, () => {
        expect(mapper.mapWebhookToPaymentStatus('PENDING', code)).toBe(PaymentStatus.FAILED);
      });
    }
  });

  // ── §6.3: PENDING + user cancellation RESPCODE → CANCELLED ────────────
  describe('PENDING + user cancellation RESPCODE → CANCELLED', () => {
    const cancellationCodes = ['503', '505', '506'];

    for (const code of cancellationCodes) {
      it(`maps PENDING + RESPCODE=${code} to CANCELLED`, () => {
        expect(mapper.mapWebhookToPaymentStatus('PENDING', code)).toBe(PaymentStatus.CANCELLED);
      });
    }
  });

  // ── §6.4: PENDING + expiry RESPCODE → EXPIRED ─────────────────────────
  describe('PENDING + expiry RESPCODE → EXPIRED', () => {
    const expiryCodes = ['501', '502', '504', '507'];

    for (const code of expiryCodes) {
      it(`maps PENDING + RESPCODE=${code} to EXPIRED`, () => {
        expect(mapper.mapWebhookToPaymentStatus('PENDING', code)).toBe(PaymentStatus.EXPIRED);
      });
    }
  });

  // ── §6.5: PENDING + in-progress RESPCODE → PROCESSING ─────────────────
  describe('PENDING + in-progress RESPCODE → PROCESSING', () => {
    const processingCodes = ['01', '100', '101', '102', '103', '200'];

    for (const code of processingCodes) {
      it(`maps PENDING + RESPCODE=${code} to PROCESSING`, () => {
        expect(mapper.mapWebhookToPaymentStatus('PENDING', code)).toBe(PaymentStatus.PROCESSING);
      });
    }
  });

  // ── §6.6: Unknown STATUS → throw ──────────────────────────────────────
  describe('Unknown STATUS throws', () => {
    it('throws GatewayMappingError for unknown STATUS', () => {
      expect(() => mapper.mapWebhookToPaymentStatus('UNKNOWN', '01')).toThrow(GatewayMappingError);
    });

    it('throws GatewayMappingError for empty STATUS', () => {
      expect(() => mapper.mapWebhookToPaymentStatus('', '01')).toThrow(GatewayMappingError);
    });
  });

  // ── §6.6: PENDING + unknown RESPCODE → throw ──────────────────────────
  describe('PENDING + unknown RESPCODE throws', () => {
    it('throws GatewayMappingError for PENDING with unrecognized RESPCODE', () => {
      expect(() => mapper.mapWebhookToPaymentStatus('PENDING', '99999')).toThrow(
        GatewayMappingError,
      );
    });

    it('throws GatewayMappingError for PENDING with empty RESPCODE', () => {
      expect(() => mapper.mapWebhookToPaymentStatus('PENDING', '')).toThrow(GatewayMappingError);
    });

    it('GatewayMappingError message includes the unknown RESPCODE', () => {
      try {
        mapper.mapWebhookToPaymentStatus('PENDING', 'UNKNOWN_CODE');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GatewayMappingError);
        expect((err as GatewayMappingError).message).toContain('UNKNOWN_CODE');
      }
    });
  });

  // ── No silent fallback ────────────────────────────────────────────────
  it('does NOT return SUCCESS as fallback for unknown STATUS', () => {
    expect(() => mapper.mapWebhookToPaymentStatus('SOME_STATUS', '01')).toThrow();
  });

  it('does NOT return PROCESSING as fallback for unknown RESPCODE', () => {
    expect(() => mapper.mapWebhookToPaymentStatus('PENDING', 'UNKNOWN')).toThrow();
  });
});

// ===========================================================================
// toPaymentResult
// ===========================================================================

describe('PaytmMapper.toPaymentResult', () => {
  it('maps PaytmTransactionStatusResponse to GatewayPaymentResult', () => {
    const result = mapper.toPaymentResult(mockTransactionStatusResponse);

    expect(result.gatewayId).toBe('20240115111212800110168234501612345');
    expect(result.status).toBe(PaymentStatus.SUCCESS);
    expect(result.amount).toBe(50000); // "500.00" rupees → 50000 paise
    expect(result.currency).toBe('INR');
    expect(result.gatewayOrderId).toBe('ORDER_001');
  });

  it('preserves the raw response in the raw field', () => {
    const result = mapper.toPaymentResult(mockTransactionStatusResponse);
    expect(result.raw).toBe(mockTransactionStatusResponse);
  });

  it('correctly maps TXN_FAILURE status', () => {
    const raw: PaytmTransactionStatusResponse = {
      ...mockTransactionStatusResponse,
      body: {
        ...mockTransactionStatusResponse.body,
        status: 'TXN_FAILURE',
        txnAmount: '100.00',
      },
    };
    const result = mapper.toPaymentResult(raw);
    expect(result.status).toBe(PaymentStatus.FAILED);
    expect(result.amount).toBe(10000); // "100.00" rupees → 10000 paise
  });

  it('correctly maps PENDING status', () => {
    const raw: PaytmTransactionStatusResponse = {
      ...mockTransactionStatusResponse,
      body: {
        ...mockTransactionStatusResponse.body,
        status: 'PENDING',
      },
    };
    const result = mapper.toPaymentResult(raw);
    expect(result.status).toBe(PaymentStatus.PROCESSING);
  });

  it('handles missing txnAmount gracefully (returns 0)', () => {
    const raw: PaytmTransactionStatusResponse = {
      ...mockTransactionStatusResponse,
      body: {
        ...mockTransactionStatusResponse.body,
        txnAmount: undefined as unknown as string,
      },
    };
    const result = mapper.toPaymentResult(raw);
    expect(result.amount).toBe(0);
  });
});

// ===========================================================================
// toRefundResult
// ===========================================================================

describe('PaytmMapper.toRefundResult', () => {
  it('maps PaytmRefundResponse to GatewayRefundResult', () => {
    const result = mapper.toRefundResult(mockRefundResponse);

    expect(result.gatewayRefundId).toBe('REFUND_001');
    expect(result.gatewayPaymentId).toBe('20240115111212800110168234501612345');
    expect(result.status).toBe(RefundStatus.SUCCESS);
    expect(result.amount).toBe(50000); // "500.00" rupees → 50000 paise
    expect(result.currency).toBe('INR');
  });

  it('preserves the raw response in the raw field', () => {
    const result = mapper.toRefundResult(mockRefundResponse);
    expect(result.raw).toBe(mockRefundResponse);
  });

  it('correctly maps all refund states', () => {
    const states: Array<[typeof mockRefundResponse.body.status, RefundStatus]> = [
      ['ACCEPTED', RefundStatus.PENDING],
      ['PENDING', RefundStatus.PROCESSING],
      ['SUCCESS', RefundStatus.SUCCESS],
      ['FAILED', RefundStatus.FAILED],
      ['REVERSED', RefundStatus.FAILED],
    ];

    for (const [paytmState, expectedStatus] of states) {
      const raw: PaytmRefundResponse = {
        ...mockRefundResponse,
        body: { ...mockRefundResponse.body, status: paytmState },
      };
      const result = mapper.toRefundResult(raw);
      expect(result.status).toBe(expectedStatus);
    }
  });
});

// ===========================================================================
// parseAmountToPaise
// ===========================================================================

describe('PaytmMapper.parseAmountToPaise', () => {
  it('converts "500.00" to 50000 paise', () => {
    expect(mapper.parseAmountToPaise('500.00')).toBe(50000);
  });

  it('converts "1.00" to 100 paise', () => {
    expect(mapper.parseAmountToPaise('1.00')).toBe(100);
  });

  it('converts "0.50" to 50 paise', () => {
    expect(mapper.parseAmountToPaise('0.50')).toBe(50);
  });

  it('converts "1000" to 100000 paise', () => {
    expect(mapper.parseAmountToPaise('1000')).toBe(100000);
  });

  it('returns 0 for undefined input', () => {
    expect(mapper.parseAmountToPaise(undefined)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(mapper.parseAmountToPaise('')).toBe(0);
  });

  it('returns 0 for non-numeric string', () => {
    expect(mapper.parseAmountToPaise('not_a_number')).toBe(0);
  });
});

// ===========================================================================
// formatAmountRupees
// ===========================================================================

describe('PaytmMapper.formatAmountRupees', () => {
  it('converts 50000 paise to "500.00"', () => {
    expect(mapper.formatAmountRupees(50000)).toBe('500.00');
  });

  it('converts 100 paise to "1.00"', () => {
    expect(mapper.formatAmountRupees(100)).toBe('1.00');
  });

  it('converts 50 paise to "0.50"', () => {
    expect(mapper.formatAmountRupees(50)).toBe('0.50');
  });

  it('converts 0 paise to "0.00"', () => {
    expect(mapper.formatAmountRupees(0)).toBe('0.00');
  });
});
