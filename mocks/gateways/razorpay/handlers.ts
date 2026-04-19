// handlers.ts

import { createOrderHandler } from './orders/create.handler';
import { getOrderHandler } from './orders/get.handler';

// ✅ FIX: correct files
import { createRefundHandler } from './orders/refund';
import { getRefundHandler } from './orders/refund.get.handler';

export const razorpayHandlers = [
  createOrderHandler,
  getOrderHandler,
  createRefundHandler,
  getRefundHandler,
];
