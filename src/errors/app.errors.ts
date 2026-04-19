// app.error.ts
// Base error class for the entire checkoutOs system.
//
// All domain errors extend AppError — never throw plain Error objects.
// This gives the error middleware everything it needs to format a correct
// HTTP response without any switch statements or instanceof chains.
// ─────────────────────────────────────────────────────────────────────────────

import type { ErrorCodeValue } from '../types/common.types';

export abstract class AppError extends Error {
  abstract readonly httpStatus: number;

  // readonly code: ErrorCodeValue;
  readonly code: ErrorCodeValue;
  readonly details: Record<string, unknown>;
  /* Whether this error was caused by the client (true) or the system (false).
    
       isOperational = true  → warn  (client made a bad request)
       isOperational = false → error (unexpected system failure)
       */
  readonly isOperational: boolean;

  constructor(
    code: ErrorCodeValue,
    message: string,
    details: Record<string, unknown> = {},
    isOperational: boolean = true,
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    // when extending built-in classes in TypeScript/ES5 targets
    Object.setPrototypeOf(this, new.target.prototype);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    this.name = this.constructor.name;
    // "PaymentNotFoundError: insded of "Error"
  }
}
