// src/routes/checkout.routes.ts

import { Router } from 'express';
import { checkoutPage } from '../controllers/checkout.controller';

export const checkoutRouter = Router();

checkoutRouter.get('/:chkId', checkoutPage);
