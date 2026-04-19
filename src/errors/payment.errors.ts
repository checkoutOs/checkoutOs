// payment.error.ts
// Typed errors for payment and refund domain failures

// HTTP status code reasoning:
//   404 → resource doesn't exist (payment/refund not found)
//   400 → client sent invalid data (bad amount)
//   402 → payment required / payment declined (gateway rejected)
//   422 → request is valid but cannot be processed (refund not allowed)
//   502 → upstream (gateway) returned an unexpected response

import { AppError } from './app.errors';
import { ErrorCode } from '../types/common.types';

// Payment not found
// when chk_ID has no matching record in Redis

export class PaymentNotFoundError extends AppError {
  readonly httpStatus = 404;

  constructor(chkId: string) {
    super(ErrorCode.PAYMENT_NOT_FOUND, `Payment not found: ${chkId}`, { chkId });
  }
}

// Payment failed
// Throw when gateway reports a terminal failure status on payment

export class PaymentFailedError extends AppError {
  readonly httpStatus = 402;

  constructor(chkId: string, reason?: string) {
    super(ErrorCode.PAYMENT_FAILED, reason ?? 'Payment was declined by the gateway', { chkId });
  }
}

// Payment creation failed
// Throw when gateway call to create a payment fails unexpectedly 502 when received an invalid response from an upstream server gateway

export class PaymentCreationFailedError extends AppError {
  readonly httpStatus = 502;

  constructor(gateway: string, reason?: string) {
    super(
      ErrorCode.PAYMENT_CREATION_FAILED,
      reason ?? `Failed to create payment on ${gateway}`,
      { gateway },
      false, // Not operationla - this is a system-level failure
    );
  }
}

// Invalid amount
// Throw when the request amoutn is zero, negative , or non-integer
export class InvalidAmountError extends AppError {
  readonly httpStatus = 400;

  constructor(amount: unknown) {
    super(
      ErrorCode.INVALID_AMOUNT,
      'Amount must be a positive integer in paise (e.g. 50000 for ₹500)',
      { received: amount },
    );
  }
}

// Refund not allowed
// when a refund is attempted on a pyament that isn't in SUCCESS status

export class RefundNotAllowedError extends AppError {
  readonly httpStatus = 422;

  constructor(chkId: string, currentStatus: string) {
    super(
      ErrorCode.REFUND_NOT_ALLOWED,
      `Refunds are only allowed on successful payments. Current Status: ${currentStatus}`,
      { chkId, currentStatus },
    );
  }
}

// Refund not found
// Throw when a ref_ ID has no matching record in Redis.

export class RefundNotFoundError extends AppError {
  readonly httpStatus = 404;

  constructor(refId: string) {
    super(ErrorCode.REFUND_NOT_FOUND, `Refund not found: ${refId}`, { refId });
  }
}

// Refund amount exceeds payment
// when requested refund amount is greater than the original payment

export class RefundAmountExceedsPaymentError extends AppError {
  readonly httpStatus = 422;

  constructor(refundAmount: number, paymentAmount: number) {
    super(
      ErrorCode.REFUND_AMOUNT_EXCEEDS_PAYMENT,
      `Refund amoutn (${refundAmount} paise) exceeds original payment amount (${paymentAmount} paise)`,
      { refundAmount, paymentAmount },
    );
  }
}

// Refund failed
// when the gateway reports a terminal failure on a refund.
export class RefundFailedError extends AppError {
  readonly httpStatus = 502;

  constructor(refId: string, reason?: string) {
    super(
      ErrorCode.REFUND_FAILED,
      reason ?? 'Refund was rejected by the gateway',
      { refId },
      false,
    );
  }
}
