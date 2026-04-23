// src/errors/paytm.errors.ts
// Paytm-specific error classes.

import { AppError } from './app.errors';
import { ErrorCode } from '../types/common.types';

export class PaytmPhoneRequiredError extends AppError {
  readonly httpStatus = 400;
  readonly code = ErrorCode.PAYTM_PHONE_REQUIRED;
  readonly isOperational = true;
  readonly details: Record<string, unknown>;

  constructor() {
    super(
      ErrorCode.PAYTM_PHONE_REQUIRED,
      'Customer phone number is required for Paytm payments',
      {
        reason: 'Paytm requires customerPhone to send the SMS payment link',
        hint: 'Include customerPhone in the CreatePaymentRequest',
      },
      true,
    );
    this.details = {
      reason: 'Paytm requires customerPhone to send the SMS payment link',
      hint: 'Include customerPhone in the CreatePaymentRequest',
    };
  }
}

export class PaytmChecksumFailedError extends AppError {
  readonly httpStatus = 400;
  readonly code = ErrorCode.PAYTM_CHECKSUM_FAILED;
  readonly isOperational = true;
  readonly details: Record<string, unknown>;

  constructor(reason?: string) {
    const errorReason =
      reason ?? 'The CHECKSUMHASH in the webhook body does not match the expected value';
    super(
      ErrorCode.PAYTM_CHECKSUM_FAILED,
      'Paytm checksum verification failed',
      {
        reason: errorReason,
        hint: 'Verify the webhook secret matches the Paytm merchant key and the body was not consumed before verification',
      },
      true,
    );
    this.details = {
      reason: errorReason,
      hint: 'Verify the webhook secret matches the Paytm merchant key and the body was not consumed before verification',
    };
  }
}

export class PaytmWebhookParseError extends AppError {
  readonly httpStatus = 400;
  readonly code = ErrorCode.PAYTM_WEBHOOK_PARSE_ERROR;
  readonly isOperational = true;
  readonly details: Record<string, unknown>;

  constructor(reason?: string) {
    const errorReason = reason ?? 'The webhook body is not valid URL-encoded (NVP) format';
    super(
      ErrorCode.PAYTM_WEBHOOK_PARSE_ERROR,
      'Failed to parse Paytm webhook payload',
      {
        reason: errorReason,
        hint: 'Ensure the Paytm webhook route has express.urlencoded({ extended: true }) middleware mounted before express.json()',
      },
      true,
    );
    this.details = {
      reason: errorReason,
      hint: 'Ensure the Paytm webhook route has express.urlencoded({ extended: true }) middleware mounted before express.json()',
    };
  }
}
