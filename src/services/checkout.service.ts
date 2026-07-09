// src/services/checkout.service.ts

import { findPaymentByChkId } from '../store/payment.store';
import type { StoredPayment } from '../types/payment.types';
import { PaymentNotFoundError } from '../errors/payment.errors';

/**
 * Fetch payment data for the checkout page.
 * Returns the full StoredPayment so the controller can pass it to
 * plugin.getCheckoutAction() for gateway-specific checkout behavior.
 */
export async function getCheckoutData(chkId: string): Promise<StoredPayment> {
  const payment = await findPaymentByChkId(chkId);

  if (!payment) {
    throw new PaymentNotFoundError(chkId);
  }

  return payment;
}
