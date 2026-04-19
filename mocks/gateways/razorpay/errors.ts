// Razorpay Error Response Shapes

/* Razorpay returns errors in a consistent envelope:
 * {
 *   error: {
 *     code: string        — machine-readable error code
 *     description: string — human-readable message
 *     field: string|null  — which field caused the error (validation only)
 *     source: string      — who produced the error (gateway, business, etc.)
 *     step: string        — at which step the error occurred
 *     reason: string      — why it failed
 *   }
 * }
 *
 * This module provides typed builders for each error case.
 */

import { HttpResponse } from 'msw';

interface RazorpayError {
  code: string;
  description: string;
  field: string | null;
  source: string;
  step: string;
  reason: string;
}

function razorpayError(status: number, error: RazorpayError): Response {
  return HttpResponse.json({ error }, { status });
}

// Auth Errors
export function missingAuthError(): Response {
  return razorpayError(401, {
    code: 'BAD_REQUEST_ERROR',
    description: 'Authentication failed. No credentials provided.',
    field: null,
    source: 'NA',
    step: 'payment_initiation',
    reason: 'input_validation_failed',
  });
}

export function invalidCredentialsError(): Response {
  return razorpayError(401, {
    code: 'BAD_REQUEST_ERROR',
    description:
      'The API credentials passed in the API call differ from the ones generated on the Dashboard.',
    field: null,
    source: 'NA',
    step: 'payment_initiation',
    reason: 'input_validation_failed',
  });
}

// ─── Validation Errors ────────────────────────────────────────────────────────

export function missingFieldError(field: string): Response {
  return razorpayError(400, {
    code: 'BAD_REQUEST_ERROR',
    description: `The ${field} field is required.`,
    field,
    source: 'business',
    step: 'payment_initiation',
    reason: 'input_validation_failed',
  });
}

export function invalidAmountError(): Response {
  return razorpayError(400, {
    code: 'BAD_REQUEST_ERROR',
    description:
      'The amount must be at least 100 (paise). Currency subunits must be greater than 100.',
    field: 'amount',
    source: 'business',
    step: 'payment_initiation',
    reason: 'input_validation_failed',
  });
}

export function invalidCurrencyError(): Response {
  return razorpayError(400, {
    code: 'BAD_REQUEST_ERROR',
    description: 'The currency provided is not supported.',
    field: 'currency',
    source: 'business',
    step: 'payment_initiation',
    reason: 'input_validation_failed',
  });
}

export function invalidRequestBodyError(): Response {
  return razorpayError(400, {
    code: 'BAD_REQUEST_ERROR',
    description: 'The request body is missing or contains invalid JSON.',
    field: null,
    source: 'business',
    step: 'payment_initiation',
    reason: 'input_validation_failed',
  });
}
