// not-found.middleware.ts
// Handles requests that did not match any registered route.
//
// Must be registered AFTER all routes in app.ts so it only fires
// when no route matched. Returns the same ApiErrorResponse shape
// as every other error in the system — never Express's default HTML page.
//
// Calls next(err) rather than sending a response directly so the
// error handler middleware formats the response consistently.
// This also means the not-found case appears in error logs with
// the same structure as all other errors.

import { Request, Response, NextFunction } from 'express';
import { ErrorCode } from '../types/common.types';
import { error as errorResponse } from '../utils/response';

export function notFoundHandler(
  req: Request,
  res: Response,
  // next included so signature is explicit — not used because we
  // send the response directly here rather than delegating to errorHandler.
  // A 404 for an unknown route is not worth an error log entry.
  _next: NextFunction,
): void {
  res
    .status(404)
    .json(errorResponse(ErrorCode.NOT_FOUND, `Route not found: ${req.method} ${req.path}`));
}
