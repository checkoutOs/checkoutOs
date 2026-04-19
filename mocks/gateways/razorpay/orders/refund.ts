import { http, HttpResponse } from 'msw';
import { ValidateBasicAuth } from '../auth.ts';
import { missingAuthError, invalidCredentialsError } from '../errors.ts';

import { paymentStore, refundStore } from '../store.ts';
import type { StoredRefund } from '../store.ts';

const MOCK_CREATED_AT = 1705314600;

export const createRefundHandler = http.post(
  '/v1/payments/:paymentId/refund',
  async ({ request, params }) => {
    const authResult = ValidateBasicAuth(request);

    if (!authResult.valid) {
      if (authResult.reason === 'missing_header') {
        return missingAuthError();
      }
      return invalidCredentialsError();
    }

    const { paymentId } = params as { paymentId: string };

    const payment = paymentStore.get(paymentId);

    if (!payment) {
      return HttpResponse.json(
        {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'The payment does not exist.',
            field: null,
            source: 'business',
            step: 'refund_initiation',
            reason: 'input_validation_failed',
          },
        },
        { status: 404 },
      );
    }

    if (payment.status !== 'captured') {
      return HttpResponse.json(
        {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'Payment is not captured.',
            field: null,
            source: 'business',
            step: 'refund_initiation',
            reason: 'input_validation_failed',
          },
        },
        { status: 400 },
      );
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch (err: unknown) {
      console.warn('Mock refund handler: failed to parse request body', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const requestedAmount: number = typeof body.amount === 'number' ? body.amount : payment.amount;

    if (requestedAmount <= 0) {
      return HttpResponse.json(
        {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'The refund amount is invalid.',
            field: 'amount',
            source: 'business',
            step: 'refund_initiation',
            reason: 'input_validation_failed',
          },
        },
        { status: 400 },
      );
    }

    const remaining = payment.amount - payment.refunded_amount;

    if (requestedAmount > remaining) {
      return HttpResponse.json(
        {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'Refund amount exceeds the available refundable amount.',
            field: 'amount',
            source: 'business',
            step: 'refund_initiation',
            reason: 'input_validation_failed',
          },
        },
        { status: 400 },
      );
    }

    const refundId = `rfnd_${Date.now()}`;

    const refund: StoredRefund = {
      id: refundId,
      entity: 'refund',
      amount: requestedAmount,
      currency: payment.currency,
      payment_id: paymentId,
      status: 'processed',
      created_at: MOCK_CREATED_AT,
    };

    refundStore.set(refundId, refund);

    payment.refunded_amount += requestedAmount;

    return HttpResponse.json(refund, { status: 200 });
  },
);
