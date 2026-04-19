//  store.erros.ts
// Typed error for Redis store failures , It's always system lever failure never caused by client input
// 500 -> Internal server error if redis is down we can not correlate Id or persist state

import { AppError } from './app.errors';
import { ErrorCode } from '../types/common.types';

//  throw by payment.store.ts and refund.store.ts when Redis operatoin fails
// The store layer catched ioredis errors and re-throws as StoreError

export class StoreError extends AppError {
  readonly httpStatus = 500;

  constructor(operation: string, cause?: unknown) {
    super(
      ErrorCode.STORE_ERROR,
      `Store operation failed: ${operation}`,
      {
        operation,
        // Safely serialize the cause for the details field.
        cause: cause instanceof Error ? cause.message : String(cause),
      },
      false, // Not operational this is always a system failure
    );
  }
}
