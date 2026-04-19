import { http, HttpResponse } from 'msw';
import { ValidateBasicAuth } from '../auth.ts';

import {
  missingAuthError,
  invalidCredentialsError,
  missingFieldError,
  invalidAmountError,
  invalidCurrencyError,
  invalidRequestBodyError,
} from '../errors.ts';

import { orderStore, markOrderPaid } from '../store.ts';
import type { StoredOrder } from '../store.ts';

// Types

interface CreateOrderRequestBody {
  amount?: unknown;
  currency?: unknown;
  receipt?: unknown;
  note?: Record<string, string>;
  partial_payment?: boolean;
}

const SUPPORTED_CURRENCIES = ['INR', 'USD', 'EUR', 'SGD', 'GBP', 'AED'];

const MOCK_CREATED_AT = 1705314600;

function deriveOrderId(receipt: string | null | undefined): string {
  if (!receipt) {
    return 'order_mock_default001';
  }
  const suffix = Buffer.from(receipt)
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 14)
    .padEnd(14, '0');
  return `order_${suffix}`;
}

// 🔥 Webhook trigger helper
async function triggerWebhook(paymentId: string) {
  try {
    await fetch('http://localhost:3000/webhooks/razorpay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: paymentId,
              status: 'captured',
            },
          },
        },
      }),
    });
  } catch (err) {
    console.error('[Mock] Webhook trigger failed:', err);
  }
}

// Handler

export const createOrderHandler = http.post('/v1/orders', async ({ request }) => {
  // 🔐 Auth validation
  const authResult = ValidateBasicAuth(request);

  if (!authResult.valid) {
    if (authResult.reason === 'missing_header') {
      return missingAuthError();
    }
    return invalidCredentialsError();
  }

  let body: CreateOrderRequestBody;

  try {
    body = (await request.json()) as CreateOrderRequestBody;
  } catch {
    return invalidRequestBodyError();
  }

  if (body.amount === undefined || body.amount === null) {
    return missingFieldError('amount');
  }

  if (typeof body.amount !== 'number' || !Number.isInteger(body.amount) || body.amount < 100) {
    return invalidAmountError();
  }

  if (typeof body.currency !== 'string' || !SUPPORTED_CURRENCIES.includes(body.currency)) {
    return invalidCurrencyError();
  }

  const receipt = typeof body.receipt === 'string' ? body.receipt : null;

  const orderId = deriveOrderId(receipt);

  const storedOrder: StoredOrder = {
    id: orderId,
    entity: 'order',
    amount: body.amount,
    amount_paid: 0,
    amount_due: body.amount,
    currency: body.currency,
    receipt,
    offer_id: null,
    status: 'created',
    attempts: 0,
    notes: body.note ?? {},
    created_at: MOCK_CREATED_AT,
  };

  // ✅ Save order
  orderStore.set(orderId, storedOrder);

  setTimeout(async () => {
    const paymentId = markOrderPaid(orderId);

    if (!paymentId) return;

    await triggerWebhook(paymentId);
  }, 2000);

  return HttpResponse.json(storedOrder, { status: 200 });
});
