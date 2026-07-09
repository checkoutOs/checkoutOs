// mocks/gateways/paytm/handlers.ts
// MSW handlers for the Paytm API.
//
// Mocked endpoints:
//   POST /theia/api/v1/initiateTransaction  — createPayment
//   POST /theia/api/v1/transactionStatus    — getPaymentStatus / healthCheck
//   POST /theia/api/v1/refundTransaction    — createRefund
//
// Deterministic: no randomness — responses are derived from request fields.
// Auth: checks that PAYTM_MERCHANT_ID in the request body matches the test MID.
//
// To use in tests: set PAYTM_BASE_URL=http://localhost:9090
// The mock server shares port 9090 with the Razorpay mock (different URL paths).
//
// Note: This mock does NOT verify CHECKSUMHASH signatures.
// Signature verification is the plugin's responsibility and is tested separately
// by mocking the paytmchecksum library in unit/integration tests.

import { http, HttpResponse } from 'msw';

// Test merchant credentials — match these in vitest.setup.integration.ts
// or your PAYTM_* env vars when using PAYTM_BASE_URL=http://localhost:9090.
export const MOCK_PAYTM_MERCHANT_ID = 'paytm_test_mid_001';
export const MOCK_PAYTM_MERCHANT_KEY = 'paytm_test_key_001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResultInfo(
  status: 'S' | 'F' | 'P',
  code: string,
  msg: string,
): { resultStatus: string; resultCode: string; resultMsg: string } {
  return { resultStatus: status, resultCode: code, resultMsg: msg };
}

function extractBody(requestBody: unknown): Record<string, unknown> {
  if (
    requestBody !== null &&
    typeof requestBody === 'object' &&
    'body' in requestBody &&
    requestBody.body !== null &&
    typeof requestBody.body === 'object'
  ) {
    return requestBody.body as Record<string, unknown>;
  }
  return {};
}

function unauthorizedResponse(mid: string): HttpResponse {
  return HttpResponse.json(
    {
      head: {},
      body: {
        resultInfo: buildResultInfo('F', '0001', `Merchant ${mid} not found or unauthorized`),
      },
    },
    { status: 401 },
  );
}

// ---------------------------------------------------------------------------
// POST /theia/api/v1/initiateTransaction — createPayment
// ---------------------------------------------------------------------------
// Returns a txnToken and paymentUrl for the given orderId.
// Fails with 401 if the MID does not match the test merchant ID.

const initiateTransactionHandler = http.post(
  '/theia/api/v1/initiateTransaction',
  async ({ request }) => {
    let requestBody: unknown;
    try {
      requestBody = await request.json();
    } catch {
      return HttpResponse.json(
        { head: {}, body: { resultInfo: buildResultInfo('F', '0002', 'Invalid request body') } },
        { status: 400 },
      );
    }

    const body = extractBody(requestBody);
    const mid = body['mid'];
    const orderId = body['orderId'];
    const txnAmount = body['txnAmount'] as { value?: string } | undefined;

    if (mid !== MOCK_PAYTM_MERCHANT_ID) {
      return unauthorizedResponse(String(mid));
    }

    if (!orderId || typeof orderId !== 'string') {
      return HttpResponse.json(
        { head: {}, body: { resultInfo: buildResultInfo('F', '0003', 'orderId is required') } },
        { status: 400 },
      );
    }

    const amount = txnAmount?.value ?? '500.00';
    const txnToken = `TKN_${orderId}_${Buffer.from(orderId).toString('hex').slice(0, 10)}`;
    const paymentUrl = `http://localhost:9090/theia/api/v1/showPaymentPage?mid=${MOCK_PAYTM_MERCHANT_ID}&orderId=${encodeURIComponent(orderId)}`;

    return HttpResponse.json({
      head: {},
      body: {
        resultInfo: buildResultInfo('S', '0000', 'Success'),
        txnToken,
        orderId,
        amount,
        paymentUrl,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// POST /theia/api/v1/transactionStatus — getPaymentStatus / healthCheck
// ---------------------------------------------------------------------------
// Returns PENDING for all orders unless the orderId ends with '_paid'
// (test shortcut to simulate a completed payment without a webhook).

const transactionStatusHandler = http.post(
  '/theia/api/v1/transactionStatus',
  async ({ request }) => {
    let requestBody: unknown;
    try {
      requestBody = await request.json();
    } catch {
      return HttpResponse.json(
        { head: {}, body: { resultInfo: buildResultInfo('F', '0002', 'Invalid request body') } },
        { status: 400 },
      );
    }

    const body = extractBody(requestBody);
    const mid = body['mid'];
    const orderId = body['orderId'];

    if (mid !== MOCK_PAYTM_MERCHANT_ID) {
      return unauthorizedResponse(String(mid));
    }

    // Health check dummy order → return structured error (still HTTP 200 with failure body)
    if (typeof orderId === 'string' && orderId.startsWith('HEALTH_CHECK')) {
      return HttpResponse.json({
        head: {},
        body: {
          resultInfo: buildResultInfo('F', '0330', `Order ${orderId} not found`),
        },
      });
    }

    // Unknown order → PENDING (typical state after creation, before payment)
    const txnId = `TXN_${orderId}_001`;
    const status =
      typeof orderId === 'string' && orderId.endsWith('_paid') ? 'TXN_SUCCESS' : 'PENDING';

    return HttpResponse.json({
      head: {},
      body: {
        txnId,
        orderId,
        txnAmount: '500.00',
        currency: 'INR',
        status,
        respCode: status === 'TXN_SUCCESS' ? '01' : '100',
        respMsg: status === 'TXN_SUCCESS' ? 'Txn Successful' : 'Payment initiated',
        resultInfo: buildResultInfo(
          status === 'TXN_SUCCESS' ? 'S' : 'P',
          status === 'TXN_SUCCESS' ? '0000' : '0001',
          status === 'TXN_SUCCESS' ? 'Success' : 'Pending',
        ),
      },
    });
  },
);

// ---------------------------------------------------------------------------
// POST /theia/api/v1/refundTransaction — createRefund
// ---------------------------------------------------------------------------
// Always returns ACCEPTED (refund queued) for valid requests.

const refundTransactionHandler = http.post(
  '/theia/api/v1/refundTransaction',
  async ({ request }) => {
    let requestBody: unknown;
    try {
      requestBody = await request.json();
    } catch {
      return HttpResponse.json(
        { head: {}, body: { resultInfo: buildResultInfo('F', '0002', 'Invalid request body') } },
        { status: 400 },
      );
    }

    const body = extractBody(requestBody);
    const mid = body['mid'];
    const txnId = body['txnId'];
    const refId = body['refId'];
    const refundAmount = body['refundAmount'];

    if (mid !== MOCK_PAYTM_MERCHANT_ID) {
      return unauthorizedResponse(String(mid));
    }

    const refundId = `REFUND_${refId}_001`;

    return HttpResponse.json({
      head: {},
      body: {
        resultInfo: buildResultInfo('S', '0000', 'Success'),
        refundId,
        txnId,
        orderId: `ORDER_FOR_${txnId}`,
        refundAmount,
        currency: 'INR',
        status: 'ACCEPTED',
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const paytmHandlers = [
  initiateTransactionHandler,
  transactionStatusHandler,
  refundTransactionHandler,
];
