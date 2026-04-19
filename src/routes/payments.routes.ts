// payment.routes.ts
// POST /payments
// GET  /payments/:chkId
// POST /payments/:chkId/refund

import { Router } from 'express';
import { create, getStatus, refund } from '../controllers/payments.controller';

export const paymentRouter = Router();

paymentRouter.post('/', create);
paymentRouter.get('/:chkId', getStatus);
paymentRouter.post('/:chkId/refund', refund);
