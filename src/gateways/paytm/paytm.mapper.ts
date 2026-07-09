// src/gateways/paytm/paytm.mapper.ts
// Implements GatewayMapper for Paytm.
// Translates raw Paytm API responses → unified gateway types.
// Maps Paytm STATUS + RESPCODE combinations → unified PaymentStatus.
//
// Pure translation only — no HTTP, no config, no side effects.
// This class is instantiated once and injected into PaytmPlugin.

import { PaymentStatus, RefundStatus } from '../../types/payment.types';
import {
  GatewayMapper,
  GatewayPaymentResult,
  GatewayRefundResult,
} from '../../types/gateway.types';
import { GatewayMappingError } from '../../errors';

import type { PaytmTransactionStatusResponse, PaytmRefundResponse } from './paytm.types';

// ---------------------------------------------------------------------------
// PaytmMapper
// ---------------------------------------------------------------------------

export class PaytmMapper implements GatewayMapper<
  PaytmTransactionStatusResponse,
  PaytmRefundResponse
> {
  // ---------------------------------------------------------------------------
  // toUnifiedStatus (single-string — used by poll/status checks)
  // ---------------------------------------------------------------------------
  // Maps a Paytm-native TXN_STATUS string to PaymentStatus.
  // For full STATUS + RESPCODE resolution, use mapWebhookToPaymentStatus().

  public toUnifiedStatus(gatewayStatus: string): PaymentStatus {
    switch (gatewayStatus) {
      case 'TXN_SUCCESS':
        return PaymentStatus.SUCCESS;

      case 'TXN_FAILURE':
        return PaymentStatus.FAILED;

      case 'PENDING':
        // PENDING alone is ambiguous — caller should use mapWebhookToPaymentStatus()
        // with the RESPCODE for precise classification. If only STATUS is available
        // (polling), default to PROCESSING.
        return PaymentStatus.PROCESSING;

      default:
        throw new GatewayMappingError(
          `PaytmMapper: unrecognized payment status "${gatewayStatus}". ` +
            `Expected TXN_SUCCESS, TXN_FAILURE, or PENDING. ` +
            `Add an explicit mapping in toUnifiedStatus() before deploying.`,
        );
    }
  }

  // ---------------------------------------------------------------------------
  // toUnifiedRefundStatus
  // ---------------------------------------------------------------------------

  public toUnifiedRefundStatus(gatewayStatus: string): RefundStatus {
    switch (gatewayStatus) {
      case 'ACCEPTED':
        return RefundStatus.PENDING;

      case 'PENDING':
        return RefundStatus.PROCESSING;

      case 'SUCCESS':
        return RefundStatus.SUCCESS;

      case 'FAILED':
      case 'REVERSED':
        return RefundStatus.FAILED;

      default:
        throw new GatewayMappingError(
          `PaytmMapper: unrecognized refund status "${gatewayStatus}". ` +
            `Expected ACCEPTED, PENDING, SUCCESS, FAILED, or REVERSED. ` +
            `Add an explicit mapping in toUnifiedRefundStatus() before deploying.`,
        );
    }
  }

  // ---------------------------------------------------------------------------
  // mapWebhookToPaymentStatus — COMPLETE STATUS + RESPCODE MATRIX
  // ---------------------------------------------------------------------------
  // This is THE critical method for Paytm integration.
  //
  // Implements the complete matrix from Integration Plan §6:
  //   - TXN_SUCCESS  → always SUCCESS
  //   - TXN_FAILURE  → always FAILED
  //   - PENDING      → resolved by RESPCODE sub-classification
  //
  // Throw policy: unknown STATUS or RESPCODE throws GatewayMappingError.
  // Never silently default — per Handbook §1.2 Guardrails over Trust.

  public mapWebhookToPaymentStatus(status: string, respCode: string): PaymentStatus {
    // ── Always-terminal statuses (STATUS alone determines) ───────────────────
    // §6.1: TXN_SUCCESS → SUCCESS, TXN_FAILURE → FAILED

    switch (status) {
      case 'TXN_SUCCESS':
        return PaymentStatus.SUCCESS;

      case 'TXN_FAILURE':
        return PaymentStatus.FAILED;

      case 'PENDING':
        return this.resolvePendingStatus(respCode);

      default:
        throw new GatewayMappingError(
          `PaytmMapper: unrecognized webhook STATUS "${status}". ` +
            `Expected TXN_SUCCESS, TXN_FAILURE, or PENDING. ` +
            `Add an explicit mapping in mapWebhookToPaymentStatus() before deploying.`,
        );
    }
  }

  // ---------------------------------------------------------------------------
  // resolvePendingStatus — PENDING sub-classification by RESPCODE
  // ---------------------------------------------------------------------------
  // §6.2-§6.5 of the Integration Plan.
  // Every known code explicitly listed. Unknown codes throw.

  private resolvePendingStatus(respCode: string): PaymentStatus {
    // ── §6.2: Bank-level failures → FAILED ───────────────────────────────────
    // These codes typically arrive with TXN_FAILURE, but if they appear with
    // PENDING, they also map to FAILED.

    const bankFailureCodes = new Set([
      '227', // Payment declined by bank
      '228', // Insufficient funds
      '229', // Card limit exceeded
      '230', // Card blocked
      '400', // Generic bank error
      '401', // Authentication failed
      '402', // 3D Secure failed
      '403', // Card type not supported
      '404', // Issuing bank unavailable
      '810', // Technical error at gateway
    ]);

    if (bankFailureCodes.has(respCode)) {
      return PaymentStatus.FAILED;
    }

    // ── §6.3: User cancellations → CANCELLED ─────────────────────────────────

    const cancellationCodes = new Set([
      '503', // User cancelled
      '505', // User closed page
      '506', // User timeout on OTP page
    ]);

    if (cancellationCodes.has(respCode)) {
      return PaymentStatus.CANCELLED;
    }

    // ── §6.4: Expiry/timeout → EXPIRED ───────────────────────────────────────

    const expiryCodes = new Set([
      '501', // Payment window expired
      '502', // Session timed out
      '504', // Payment link expired
      '507', // UPI collect request expired
    ]);

    if (expiryCodes.has(respCode)) {
      return PaymentStatus.EXPIRED;
    }

    // ── §6.5: In progress → PROCESSING ───────────────────────────────────────

    const processingCodes = new Set([
      '01', // Transaction initiated
      '100', // Payment initiated
      '101', // Awaiting user action
      '102', // Payment processing at bank
      '103', // Awaiting OTP
      '200', // Processing
    ]);

    if (processingCodes.has(respCode)) {
      return PaymentStatus.PROCESSING;
    }

    // ── Unknown RESPCODE: THROW — §6.6 ──────────────────────────────────────
    // No silent fallback. No default. No guessing.

    throw new GatewayMappingError(
      `PaytmMapper: unrecognized RESPCODE "${respCode}" with STATUS PENDING. ` +
        `This code is not in the RESPCODE matrix (Integration Plan §6). ` +
        `Add an explicit mapping in resolvePendingStatus() before deploying.`,
    );
  }

  // ---------------------------------------------------------------------------
  // toPaymentResult
  // ---------------------------------------------------------------------------
  // Translates a Paytm transaction status response into GatewayPaymentResult.
  // Used for status polling (getPaymentStatus).

  public toPaymentResult(raw: PaytmTransactionStatusResponse): GatewayPaymentResult {
    const body = raw.body;
    const status = this.toUnifiedStatus(body.status);
    const amountInPaise = this.parseAmountToPaise(body.txnAmount);

    return {
      gatewayId: body.txnId,
      status,
      amount: amountInPaise,
      currency: 'INR',
      gatewayOrderId: body.orderId,
      raw,
    };
  }

  // ---------------------------------------------------------------------------
  // toRefundResult
  // ---------------------------------------------------------------------------
  // Translates a Paytm refund response into GatewayRefundResult.

  public toRefundResult(raw: PaytmRefundResponse): GatewayRefundResult {
    const body = raw.body;
    const status = this.toUnifiedRefundStatus(body.status);
    const amountInPaise = this.parseAmountToPaise(body.refundAmount);

    return {
      gatewayRefundId: body.refundId,
      gatewayPaymentId: body.txnId,
      status,
      amount: amountInPaise,
      currency: 'INR',
      raw,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Paytm returns amounts as decimal strings (e.g., "500.00").
  // Convert to paise integer for internal consistency.
  public parseAmountToPaise(amountStr: string | undefined): number {
    if (!amountStr) return 0;
    const parsed = parseFloat(amountStr);
    if (isNaN(parsed)) return 0;
    return Math.round(parsed * 100); // Convert rupees to paise
  }

  // Convert paise back to rupees string for Paytm API calls.
  public formatAmountRupees(amountInPaise: number): string {
    return (amountInPaise / 100).toFixed(2);
  }
}
