// error.middleware.ts
// Central error handler for the entire checkoutOs API.
//
// This is the single place where errors become HTTP responses.
// Every other layer (services, gateways, store) throws typed AppError
// subclasses and lets them propagate. Controllers use asyncHandler which
// forwards all rejections to next(err). This middleware catches them all.
//
// Three cases:
//   1. AppError          → use err.httpStatus, err.code, err.details directly
//   2. Unknown error     → 500 INTERNAL_ERROR, never expose internals to client
//   3. Headers sent      → delegate to Express default handler to close connection
//
// Logging:
//   isOperational: true  → warn  (client made a bad request — expected)
//   isOperational: false → error (system failure — needs attention)
//
// Must be registered LAST in app.ts — Express identifies error middleware
// by the 4-argument signature (err, req, res, next).

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors';
import { error as errorResponse } from '../utils/response';
import { ErrorCode } from '../types/common.types';
import { createContextLogger } from '../utils/logger';

const log = createContextLogger('error-middleware');

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // next is required in the signature even if unused —
  // Express uses the 4-argument arity to identify error middleware

  _next: NextFunction,
): void {
  // --- Case 3: Headers already sent ---
  // A response was partially written before the error occurred.
  // Writing again would corrupt the stream — let Express close it.
  if (res.headersSent) {
    log.error('Error after headers sent', {
      method: req.method,
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // --- Case 1: Known AppError ---
  if (err instanceof AppError) {
    // isOperational: true  = client error (bad input, not found, etc.) → warn
    // isOperational: false = system failure (redis down, gateway error) → error
    if (err.isOperational) {
      log.warn('Operational error', {
        code: err.code,
        httpStatus: err.httpStatus,
        message: err.message,
        method: req.method,
        path: req.path,
      });
    } else {
      log.error('System error', {
        code: err.code,
        httpStatus: err.httpStatus,
        message: err.message,
        method: req.method,
        path: req.path,
        stack: err.stack,
      });
    }

    res.status(err.httpStatus).json(errorResponse(err.code, err.message, err.details));
    return;
  }

  // --- Case 2: Unknown error ---
  // Something unexpected — a library threw, null reference, etc.
  // Log the full error internally but never expose details to the client.
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  log.error('Unhandled error', {
    error: message,
    method: req.method,
    path: req.path,
    stack,
  });

  res
    .status(500)
    .json(
      errorResponse(
        ErrorCode.INTERNAL_ERROR,
        'An unexpected error occurred. Please try again later.',
      ),
    );
}
