// payment.controller.ts
// Handles:
//   POST /payments
//   GET  /payments/:chkId
//   POST /payments/:chkId/refund
//
// Rules:
//   - Parse request → call service → send response
//   - No business logic — validation lives in the service layer
//   - No try/catch — asyncHandler forwards all errors to next(err)
//   - Error middleware maps AppError subclasses to HTTP responses

import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { success } from '../utils/response';
import { getPaymentStatus, createPaymentWithIdempotency } from '../services/payments.service';
import { createRefund } from '../services/refunds.service';
import type { CreatePaymentRequest, CreateRefundRequest } from '../types/payment.types';

// Import express type augmentation so req.idempotency type-checks.
// Side-effect import — no symbols used directly, but the `declare module
// 'express'` block in express.types.ts adds the Request.idempotency field.
import '../types/express.types';

// ---------------------------------------------------------------------------
// POST /payments
// ---------------------------------------------------------------------------
// Body: CreatePaymentRequest
// Header: Idempotency-Key (required, UUID v4) — enforced by idempotencyMiddleware
// Response: 201 + PaymentResponse
//
// Flow:
//   1. idempotencyMiddleware reads header, validates UUID, computes hash,
//      attaches { key, requestHash } to req.idempotency
//   2. Controller extracts idempotency descriptor and forwards to the
//      idempotency-aware service orchestrator
//   3. createPaymentWithIdempotency handles HIT/MISS/IN_PROGRESS, OrderId
//      dedup, and completeIdempotency
//
// Amount validation (positive integer in paise) happens in payment.service.
// No pre-validation here — the service throws InvalidAmountError which the
// error middleware maps to HTTP 400.

export const create = asyncHandler(
  async (req: Request<object, unknown, CreatePaymentRequest>, res: Response): Promise<void> => {
    // req.idempotency is set by idempotencyMiddleware; if absent (e.g. route
    // was registered without the middleware), the service still works in
    // orderId-dedup-only mode. This keeps the contract resilient: a missing
    // middleware is a deploy bug, not a crash.
    const result = await createPaymentWithIdempotency(req.body, req.idempotency);
    res.status(201).json(success(result));
  },
);

// ---------------------------------------------------------------------------
// GET /payments/:chkId
// ---------------------------------------------------------------------------
// Params: chkId — chk_ prefixed payment ID
// Response: 200 + PaymentStatusResponse
//
// Re-poll strategy (non-terminal + staleness window) is handled in the service.
// PaymentNotFoundError → 404 via error middleware.

export const getStatus = asyncHandler(
  async (req: Request<{ chkId: string }>, res: Response): Promise<void> => {
    const { chkId } = req.params;
    const result = await getPaymentStatus(chkId);
    res.status(200).json(success(result));
  },
);

// ---------------------------------------------------------------------------
// POST /payments/:chkId/refund
// ---------------------------------------------------------------------------
// Params: chkId — chk_ prefixed payment ID
// Body: CreateRefundRequest (amount is optional — omit for full refund)
// Response: 201 + RefundResponse
//
// All refund validation (status check, amount check, gatewayPaymentId check)
// happens in payment.service.validateAndPrepareRefund via refund.service.
// Error classes thrown:
//   PaymentNotFoundError       → 404
//   RefundNotAllowedError      → 422
//   InvalidAmountError         → 400
//   RefundAmountExceedsPaymentError → 422

export const refund = asyncHandler(
  async (
    req: Request<{ chkId: string }, unknown, CreateRefundRequest>,
    res: Response,
  ): Promise<void> => {
    const { chkId } = req.params;
    const result = await createRefund(chkId, req.body);
    res.status(201).json(success(result));
  },
);
