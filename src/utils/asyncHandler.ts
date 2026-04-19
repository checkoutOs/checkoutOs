// utils/asyncHandler.ts

// If paymentService.createPayment() throws, asyncHandler catches the
// rejection and calls next(err). The error middleware then maps the
// AppError to the correct HTTP response.

// Rules:
//   - Uses unknown instead of any — ESLint any rule compliance
//   - Generic parameters default to Express own core types
//   - Return type is RequestHandler so Express route mounting is typed

import { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import { ParsedQs } from 'qs';

export function asyncHandler<
  P extends ParamsDictionary = ParamsDictionary,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery extends ParsedQs = ParsedQs,
>(
  fn: (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction,
  ) => Promise<unknown>,
): RequestHandler<P, ResBody, ReqBody, ReqQuery> {
  return (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction,
  ): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
