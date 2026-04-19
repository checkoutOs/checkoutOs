// razorpay.mapper.ts
/*
Implemetns GatewayMapper for Razorpay
Translate raw RazorpayPayment objects → GatewayPaymentResult
Translate raw RazorpayRefund objects  → GatewayRefundResult
Map Razorpay-native status strings    → unified PaymentStatus / RefundStatus

pure translation only
This class is instantiated once and injected into RazorpayPlugin
*/

import { PaymentStatus, RefundStatus } from '../../types/payment.types';
import {
  GatewayMapper,
  GatewayPaymentResult,
  GatewayRefundResult,
} from '../../types/gateway.types';

import { RazorpayPayment, RazorpayRefund } from './razorpay.types';

import { GatewayMappingError } from '../../errors';

export class RazorpayMapper implements GatewayMapper<RazorpayPayment, RazorpayRefund> {
  public toUnifiedStatus(gatewayStatus: string): PaymentStatus {
    switch (gatewayStatus) {
      case 'created':
      case 'attempted':
      case 'pending':
        return PaymentStatus.PENDING;

      case 'authorized':
      case 'processing':
        return PaymentStatus.PROCESSING;

      case 'captured':
      case 'paid':
        return PaymentStatus.SUCCESS;

      case 'failed':
        return PaymentStatus.FAILED;

      case 'refunded':
        return PaymentStatus.REFUNDED;

      // Razorpay does not emit these natively today but checkoutOs models them
      // to stay aligned with the unified PaymentStatus contract.
      case 'partially_refunded':
      case 'partial_refunded':
        return PaymentStatus.PARTIALLY_REFUNDED;

      case 'cancelled':
      case 'canceled':
        return PaymentStatus.CANCELLED;

      case 'expired':
        return PaymentStatus.EXPIRED;

      // --- Unknown status: throw immediately ---
      // Do not add a default fallback. If Razorpay introduces a new status
      // downstream in a corrupted Redis record.
      default:
        throw new GatewayMappingError(
          `RazorpayMapper: unrecognized payment status "${gatewayStatus}". ` +
            `Add an explicit mapping in toUnifiedStatus() before deploying.`,
        );
    }
  }

  public toUnifiedRefundStatus(gatewayStatus: string): RefundStatus {
    switch (gatewayStatus) {
      case 'pending':
        return RefundStatus.PENDING;

      case 'processing':
        return RefundStatus.PROCESSING;

      case 'processed':
        return RefundStatus.SUCCESS;

      case 'failed':
        return RefundStatus.FAILED;

      default:
        throw new GatewayMappingError(
          `RazorpayMapper: unrecognized refund status "${gatewayStatus}". ` +
            `Add an explicit mapping in toUnifiedRefundStatus() before deploying.`,
        );
    }
  }

  // Note: paymentUrl is NOT set here — it is constructed by the plugin during
  // createPayment() and injected after mapping, since the URL requires the
  // Razorpay key_id which the mapper must not access.

  public toPaymentResult(raw: RazorpayPayment): GatewayPaymentResult {
    return {
      gatewayId: raw.id,
      status: this.toUnifiedStatus(raw.status),
      amount: raw.amount,
      currency: 'INR',
      gatewayOrderId: raw.order_id,
      raw,
    };
  }

  // ---------------------------------------------------------------------------
  // toRefundResult
  // ---------------------------------------------------------------------------

  // Translates a raw RazorpayRefund object into a normalized GatewayRefundResult.
  // Called by the plugin after every refund API response.

  public toRefundResult(raw: RazorpayRefund): GatewayRefundResult {
    return {
      gatewayRefundId: raw.id,
      gatewayPaymentId: raw.payment_id,
      status: this.toUnifiedRefundStatus(raw.status),
      amount: raw.amount,
      currency: 'INR',
      raw,
    };
  }

  // ---------------------------------------------------------------------------
  // toUnifiedStatus  (payment)
  // ---------------------------------------------------------------------------

  // Maps a Razorpay-native payment status string to the unified PaymentStatus enum.
  //
  // Throw policy: unknown status strings throw GatewayMappingError immediately.
  // A silent fallback would risk persisting a wrong payment state in Redis,
  // which is unacceptable in a payment system. Fail loud, fix fast.
  //
  // Status source: Razorpay payment and order objects share some status strings.
  // Both are handled here since the plugin may call this for either.

  // ---------------------------------------------------------------------------
  // toUnifiedRefundStatus
  // ---------------------------------------------------------------------------

  // Maps a Razorpay-native refund status string to the unified RefundStatus enum.
  //
  // Kept separate from toUnifiedStatus() because the refund and payment status
  // spaces are completely disjoint — merging them into one function would require
  // the caller to know which space they are in, which is an implicit contract.
}
