// refund.controller.ts
// Handles:
//   GET /refunds/:refId
//
// Rules:
//   - Parse request → call service → send response
//   - No try/catch — asyncHandler forwards all errors to next(err)
//   - RefundNotFoundError → 404 via error middleware

import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { success } from '../utils/response';
import { getRefundStatus } from '../services/refunds.service';

// ---------------------------------------------------------------------------
// GET /refunds/:refId
// ---------------------------------------------------------------------------
// Params: refId — ref_ prefixed refund ID
// Response: 200 + RefundStatusResponse
//
// Same staleness re-poll strategy as payment status — terminal statuses
// are served from Redis, non-terminal statuses re-poll after 10 seconds.
// RefundNotFoundError → 404 via error middleware.

export const getStatus = asyncHandler(
  async (req: Request<{ refId: string }>, res: Response): Promise<void> => {
    const { refId } = req.params;
    const result = await getRefundStatus(refId);
    res.status(200).json(success(result));
  },
);
