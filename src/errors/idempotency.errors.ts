// idempotency.errors.ts
// Typed errors for idempotency-related client errors.
//
// HTTP status reasoning:
//   400 → client sent malformed/missing idempotency header
//   409 → request conflicts with an in-progress request

import { AppError } from './app.errors';
import { ErrorCode } from '../types/common.types';

// Idempotency key reused with a different request payload.
// Throw when the same Idempotency-Key header is sent with a different body hash.
export class IdempotencyKeyReusedError extends AppError {
  readonly httpStatus = 400;

  constructor(key: string) {
    super(
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
      `Idempotency key ${key} reused with a different request payload.`,
      { key },
    );
  }
}

// A request with the same idempotency key is already in progress.
// Throw when an IN_PROGRESS record exists and is not stale.
export class IdempotencyRequestInProgressError extends AppError {
  readonly httpStatus = 409;

  constructor(key: string) {
    super(
      ErrorCode.REQUEST_IN_PROGRESS,
      `A request with idempotency key ${key} is already in progress.`,
      { key },
    );
  }
}

// Idempotency-Key header is required for this endpoint.
export class IdempotencyKeyMissingError extends AppError {
  readonly httpStatus = 400;

  constructor() {
    super(ErrorCode.MISSING_IDEMPOTENCY_KEY, 'Idempotency-Key header is required', {});
  }
}

// Idempotency-Key header is present but not a valid UUID v4.
export class IdempotencyKeyInvalidError extends AppError {
  readonly httpStatus = 400;

  constructor(key: string) {
    super(
      ErrorCode.INVALID_IDEMPOTENCY_KEY,
      `Idempotency key ${key} is invalid — must be a UUID v4`,
      { key },
    );
  }
}
