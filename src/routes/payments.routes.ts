// payment.routes.ts
// POST /payments
// GET  /payments/:chkId
// POST /payments/:chkId/refund

import { Router } from 'express';
import { create, getStatus, refund } from '../controllers/payments.controller';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';

export const paymentRouter = Router();

// Idempotency middleware is scoped to payment CREATION only:
//   - GET /:chkId      → read-only, no duplicate risk
//   - POST /:chkId/refund → refund idempotency deferred to V1.2 per the plan
//
// The middleware runs AFTER express.json() (which is mounted in app.ts
// before the router) so req.body is already parsed when we hash it.
// On missing/invalid Idempotency-Key header it throws IdempotencyKeyMissing
// / IdempotencyKeyInvalid → 400 via error.middleware.
paymentRouter.post('/', idempotencyMiddleware, create);
paymentRouter.get('/:chkId', getStatus);
paymentRouter.post('/:chkId/refund', refund);
