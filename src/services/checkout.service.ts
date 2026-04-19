// src/services/checkout.service.ts

import { findPaymentByChkId } from '../store/payment.store';
import { CheckoutViewData } from '../views/types';
import { PaymentNotFoundError } from '../../src/errors/payment.errors';
export async function getCheckoutData(chkId: string): Promise<CheckoutViewData> {
  const payment = await findPaymentByChkId(chkId);

  if (!payment) {
    throw new PaymentNotFoundError(chkId);
  }

  return {
    chkId,
    status: payment.status,
    gatewayOrderId: payment.gatewayOrderId,
    amount: payment.amount,
    currency: payment.currency,
    gateway: payment.gateway,
  };
}
