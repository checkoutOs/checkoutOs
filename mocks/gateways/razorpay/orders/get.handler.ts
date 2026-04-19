// get.handler.ts
import { http, HttpResponse } from 'msw';
import { ValidateBasicAuth } from '../auth.ts';
import { missingAuthError, invalidCredentialsError } from '../errors.ts';

import { orderStore } from '../store.ts';

export const getOrderHandler = http.get('/v1/orders/:id', async ({ request, params }) => {
  const authResult = ValidateBasicAuth(request);

  if (!authResult.valid) {
    if (authResult.reason === 'missing_header') {
      return missingAuthError();
    }
    return invalidCredentialsError();
  }

  const { id } = params as { id: string };

  const order = orderStore.get(id);

  if (!order) {
    return HttpResponse.json(
      {
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: `The order ${id} does not exist.`,
          field: null,
          source: 'business',
          step: 'payment_fetch',
          reason: 'input_validation_failed',
        },
      },
      { status: 404 },
    );
  }

  return HttpResponse.json(order, { status: 200 });
});
