// src/controllers/checkout.controller.ts
//
// Unified checkout route: /checkout/:chkId
// Handles all gateways through the plugin's getCheckoutAction() method.
//   - Razorpay: renders HTML page with embedded SDK
//   - Paytm:     302 redirect to external payment page
//
// Per Handbook §5.2.4-5.2.5: single unified route handles all states.
// The old /checkout/success?chkId=... pattern (V1 broken) is removed.

import { Request, Response } from 'express';
import { getCheckoutData } from '../services/checkout.service';
import { getActiveGateway } from '../gateways/gateway.registry';
import { renderCheckoutPage, renderSuccessPage, renderFailurePage } from '../views/checkout.view';
import { asyncHandler } from '../utils/asyncHandler';
import type { StoredPayment } from '../types/payment.types';
import type { CheckoutViewData } from '../views/types';

/**
 * Extracts CheckoutViewData from StoredPayment for view rendering.
 * StoredPayment is a superset — views only need these 6 fields.
 */
function toViewData(payment: StoredPayment): CheckoutViewData {
  return {
    chkId: payment.chkId,
    status: payment.status,
    gatewayOrderId: payment.gatewayOrderId,
    amount: payment.amount,
    currency: payment.currency,
    gateway: payment.gateway,
  };
}

/**
 * GET /checkout/:chkId
 *
 * Unified checkout route for all gateways.
 * Terminal states render immediately. Non-terminal states delegate
 * to plugin.getCheckoutAction() for gateway-specific behavior.
 */
export const checkoutPage = asyncHandler(
  async (req: Request<{ chkId: string }>, res: Response): Promise<void> => {
    const { chkId } = req.params;

    const payment: StoredPayment = await getCheckoutData(chkId);

    // ── Terminal state: SUCCESS ──────────────────────────────────────────
    if (payment.status === 'SUCCESS') {
      res.send(renderSuccessPage(toViewData(payment)));
      return;
    }

    // ── Terminal state: FAILED ───────────────────────────────────────────
    if (payment.status === 'FAILED') {
      res.send(renderFailurePage(toViewData(payment)));
      return;
    }

    // ── Non-terminal: delegate to plugin for gateway-specific action ─────
    const plugin = getActiveGateway();
    const action = await plugin.getCheckoutAction(payment);

    if (action.type === 'redirect') {
      // Paytm: 302 redirect to external payment page
      if (!action.url) {
        throw new Error('CheckoutAction type is "redirect" but url is missing');
      }
      res.redirect(302, action.url);
      return;
    }

    // Razorpay: render HTML page with embedded SDK
    const html = renderCheckoutPage(toViewData(payment));
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  },
);
