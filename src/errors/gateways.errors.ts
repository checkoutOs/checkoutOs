// gateways.errors.ts
// Typed errors for gateway layer failures.
// Thrown inside GatewayPlugin implementations and propagate up through
// the service layer to the error middleware.
//
// HTTP status code reasoning:
//   401 → invalid webhook signature — unauthorized / unverified source
//   502 → upstream returned an unrecognized / unmappable response
//   503 → gateway is down or unreachable (service unavailable)
//   504 → gateway call exceeded configured timeout

import { AppError } from './app.errors';
import { ErrorCode } from '../types/common.types';
import type { GatewayName } from '../types/payment.types';

// ---------------------------------------------------------------------------
// GatewayTimeoutError
// ---------------------------------------------------------------------------
// Thrown when a gateway HTTP call exceeds the configured timeout.
// Service layer should NOT retry — let the client decide whether to re-poll
// status via GET /payments/:chkId.

export class GatewayTimeoutError extends AppError {
  readonly httpStatus = 504;

  constructor(gateway: GatewayName, operation: string) {
    super(
      ErrorCode.GATEWAY_TIMEOUT,
      `Gateway ${gateway} timed out during: ${operation}`,
      { gateway, operation },
      false, // System-level — not caused by client input
    );
  }
}

// ---------------------------------------------------------------------------
// GatewayUnavailableError
// ---------------------------------------------------------------------------
// Thrown when the gateway is unreachable or returns an unexpected HTTP error
// that is not a timeout (e.g. 500, 503 from Razorpay itself).

export class GatewayUnavailableError extends AppError {
  readonly httpStatus = 503;

  constructor(gateway: GatewayName, reason?: string) {
    super(
      ErrorCode.GATEWAY_UNAVAILABLE,
      reason ?? `Gateway ${gateway} is currently unavailable`,
      { gateway },
      false,
    );
  }
}

// ---------------------------------------------------------------------------
// GatewayInvalidSignatureError
// ---------------------------------------------------------------------------
// Thrown when GatewayPlugin.parseWebhookEvent() fails HMAC signature
// verification. The webhook was not sent by the gateway — could be a replay
// attack, misconfigured secret, or a forged request.

export class GatewayInvalidSignatureError extends AppError {
  readonly httpStatus = 401;

  constructor(gateway: GatewayName) {
    super(
      ErrorCode.GATEWAY_INVALID_SIGNATURE,
      `Webhook signature verification failed for gateway: ${gateway}`,
      { gateway },
      true, // Operational — bad request from an unauthorized source
    );
  }
}

// ---------------------------------------------------------------------------
// GatewayMappingError
// ---------------------------------------------------------------------------
// Thrown by RazorpayMapper (and any future GatewayMapper) when a gateway-native
// status string has no defined mapping in toUnifiedStatus() or
// toUnifiedRefundStatus().
//
// 502 because the upstream gateway returned a value checkoutOs does not
// recognise — this is a violated contract between checkoutOs and the gateway,
// not between the client and checkoutOs.
//
// Recovery: add an explicit case for the new status string in the mapper and
// redeploy. Never add a silent fallback — a wrong payment state persisted in
// Redis is far worse than a loud, visible failure.

export class GatewayMappingError extends AppError {
  readonly httpStatus = 502;

  constructor(message: string, gateway?: GatewayName) {
    super(
      ErrorCode.GATEWAY_MAPPING_ERROR,
      message,
      { ...(gateway !== undefined && { gateway }) },
      false, // System-level — the gateway sent something we cannot handle
    );
  }
}

export class RefundNotReadyError extends AppError {
  readonly httpStatus = 400;

  constructor(gateway: GatewayName, retryAfterSeconds: number = 60) {
    super(
      ErrorCode.REFUND_NOT_READY,
      `Refund endpoint not ready. This payment was captured too recently. ` +
        `Please wait ${retryAfterSeconds} seconds and retry.`,
      {
        gateway,
        retryAfterSeconds,
        reason: 'PAYMENT_SETTLEMENT_PENDING',
        hint:
          gateway === 'razorpay'
            ? 'In test mode, Razorpay requires 5-10 minutes after capture before refunds are allowed.'
            : 'The payment has not completed settlement. Retry after the suggested duration.',
      },
      true, // Operational — caused by client timing, not a system failure
    );
  }
}
