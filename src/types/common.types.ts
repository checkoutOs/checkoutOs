// common.types.ts
// shared API envelope types used by every controller response
// Every outbound HTTP response from checkoutOs is wrapped in ApiResponse<T>

// canonical success envelops
//  All successfull API response have this shape

// Example:
/* 
    {
        "success": true,
        "data": {"paymentId":"chk_...",...}
    }
*/

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

// -- Canonical error envelope

// All error API response have this shape.

/*
  
      {
          "success": false,
          "error": {
              "code": "PAYMENT_FAILED",
              "message": "Payment was declined",
              "details":{}
              }
      }
  
  */

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorPayload;
}

//  Union type

// Controllers return this Typescript narrows on the 'success' discriminat

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// Health check response

export interface ServiceHealth {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  services: {
    redis: ServiceHealth;
    gateway: ServiceHealth;
  };
}

// Error codes
// Centralized registry of all error code strings used in ApiErrorPayload.
// Every AppError subclass must reference a value from this object —
// never use raw strings in error constructors.

export const ErrorCode = {
  // Payment errors
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  PAYMENT_CREATION_FAILED: 'PAYMENT_CREATION_FAILED',

  // Refund errors
  REFUND_NOT_ALLOWED: 'REFUND_NOT_ALLOWED',
  REFUND_NOT_FOUND: 'REFUND_NOT_FOUND',
  REFUND_AMOUNT_EXCEEDS_PAYMENT: 'REFUND_AMOUNT_EXCEEDS_PAYMENT',
  REFUND_FAILED: 'REFUND_FAILED',
  REFUND_NOT_READY: 'REFUND_NOT_READY',

  // Gateway errors
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',
  GATEWAY_UNAVAILABLE: 'GATEWAY_UNAVAILABLE',
  GATEWAY_INVALID_SIGNATURE: 'GATEWAY_INVALID_SIGNATURE',
  GATEWAY_MAPPING_ERROR: 'GATEWAY_MAPPING_ERROR',

  // Paytm-specific errors (NEW)
  PAYTM_PHONE_REQUIRED: 'PAYTM_PHONE_REQUIRED',
  PAYTM_CHECKSUM_FAILED: 'PAYTM_CHECKSUM_FAILED',
  PAYTM_WEBHOOK_PARSE_ERROR: 'PAYTM_WEBHOOK_PARSE_ERROR',

  // Store errors
  STORE_ERROR: 'STORE_ERROR',

  // Request errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
