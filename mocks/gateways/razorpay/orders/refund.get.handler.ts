import { http, HttpResponse } from 'msw';
import { ValidateBasicAuth } from '../auth.ts';
import { missingAuthError, invalidCredentialsError } from '../errors.ts';

import { refundStore } from '../store.ts';

export const getRefundHandler = http.get('/v1/refunds/:id', async ({ request, params }) => {
  const authResult = ValidateBasicAuth(request);

  if (!authResult.valid) {
    if (authResult.reason === 'missing_header') {
      return missingAuthError();
    }
    return invalidCredentialsError();
  }

  const { id } = params as { id: string };

  const refund = refundStore.get(id);

  if (!refund) {
    return HttpResponse.json(
      {
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'The refund does not exist.',
          field: null,
          source: 'business',
          step: 'refund_fetch',
          reason: 'input_validation_failed',
        },
      },
      { status: 404 },
    );
  }

  return HttpResponse.json(refund, { status: 200 });
});
