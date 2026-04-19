// src/routes/checkout.routes.ts

import { Router } from 'express';
import { checkoutPage, checkoutSuccess } from '../controllers/checkout.controller';

export const checkoutRouter = Router();

checkoutRouter.get('/success', checkoutSuccess);

checkoutRouter.get('/:chkId', checkoutPage);
