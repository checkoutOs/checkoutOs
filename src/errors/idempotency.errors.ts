import { AppError } from './app.errors';
import { ErrorCode } from '../types/common.types';

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

export class IdempotencyKeyMissingError extends AppError {
  readonly httpStatus = 400;

  constructor() {
    super(ErrorCode.MISSING_IDEMPOTENCY_KEY, `Idempotency-key header is required`, {});
  }
}

export class IdempotencyKeyInvalidError extends AppError {
  readonly httpStatus = 400;

  constructor(key: string) {
    super(
      ErrorCode.INVALID_IDEMPOTENCY_KEY,
      `Idempotency key ${key} is invalid - must be a UUID v4`,
      { key },
    );
  }
}

export class OrderIdAmountMismatchError extends AppError {
  readonly httpStatus = 400;
  constructor(orderId: string, expectedAmount: number, newAmount: number) {
    super(
      ErrorCode.ORDER_ID_AMOUNT_MISMATCH,
      `Order ID ${orderId} already exists with amount ${expectedAmount}, paise,` +
        `cannot create with different amount ${newAmount}, paise`,
      { orderId, expectedAmount, newAmount },
    );
  }
}

export class orderIdCurrencyMismatchError extends AppError {
  readonly httpStatus = 400;
  constructor(orderId: string, expectedCurrency: string, newCurrency: string) {
    super(
      ErrorCode.ORDER_ID_CURRENCY_MISMATCH,
      `Order ID ${orderId} already exists with currency ${expectedCurrency},` +
        `cannot create with different currency ${newCurrency}`,
      { orderId, expectedCurrency, newCurrency },
    );
  }
}
