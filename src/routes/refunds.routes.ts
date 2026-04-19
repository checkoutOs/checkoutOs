// refund.routes.ts
// GET /refunds/:refId

import { Router } from 'express';
import { getStatus } from '../controllers/refunds.controller';

export const refundRouter = Router();

refundRouter.get('/:refId', getStatus);
