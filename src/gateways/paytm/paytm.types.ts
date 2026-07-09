// src/gateways/paytm/paytm.types.ts
// Raw response shapes returned by the Paytm API.
// These types are Paytm-specific and must never leak outside the gateway folder.
// Services and controllers only ever see the unified types from gateway.types.ts.
//
// Paytm uses a nested request/response envelope:
//   { head: { signature, ... }, body: { ... } }
//
// Webhooks arrive as URL-encoded (NVP) format with CHECKSUMHASH verification.

// ---------------------------------------------------------------------------
// API Envelope
// ---------------------------------------------------------------------------

export interface PaytmHead {
  signature?: string;
  version?: string;
  channelId?: string;
  requestTimestamp?: string;
  clientId?: string;
}

export interface PaytmRequest<T> {
  head: PaytmHead;
  body: T;
}

export interface PaytmResponse<T> {
  head: PaytmHead;
  body: T & PaytmResultInfo;
}

export interface PaytmResultInfo {
  resultInfo: {
    resultStatus: string; // 'S', 'F', 'U', 'P'
    resultCode: string;
    resultMsg: string;
  };
}

// ---------------------------------------------------------------------------
// Send Payment Request (createPayment)
// POST /theia/api/v1/initiateTransaction
// ---------------------------------------------------------------------------

export interface PaytmSendPaymentRequestBody {
  requestType: 'Payment';
  mid: string;
  websiteName: string;
  orderId: string; // Our orderId (developer's reference)
  txnAmount: {
    value: string; // amount as string (e.g., "500.00")
    currency: string;
  };
  userInfo: {
    custId?: string;
    mobile?: string;
    email?: string;
  };
  callbackUrl?: string; // Our webhook URL
}

export interface PaytmSendPaymentResponseBody {
  txnToken: string;
  orderId: string;
  paymentUrl?: string;
  redirectUrl?: string;
}

export type PaytmSendPaymentResponse = PaytmResponse<PaytmSendPaymentResponseBody>;

// ---------------------------------------------------------------------------
// Transaction Status API (getPaymentStatus)
// POST /theia/api/v1/transactionStatus
// ---------------------------------------------------------------------------

export interface PaytmTransactionStatusRequestBody {
  mid: string;
  orderId: string; // Paytm ORDERID
  txnType?: string;
}

export interface PaytmTransactionStatusResponseBody {
  txnId: string; // Paytm TXNID (gatewayPaymentId)
  orderId: string; // Paytm ORDERID
  txnAmount: string; // e.g., "500.00"
  currency: string;
  status: PaytmTxnStatus; // TXN_SUCCESS, TXN_FAILURE, PENDING
  respCode: string; // additional granularity
  respMsg: string;
  bankTxnId?: string;
  bankName?: string;
  paymentMode?: string;
  txnDate?: string;
  refundAmt?: string;
}

export type PaytmTransactionStatusResponse = PaytmResponse<PaytmTransactionStatusResponseBody>;

// Paytm native transaction status strings
export type PaytmTxnStatus = 'TXN_SUCCESS' | 'TXN_FAILURE' | 'PENDING';

// ---------------------------------------------------------------------------
// Refund API (createRefund)
// POST /theia/api/v1/refundTransaction
// ---------------------------------------------------------------------------

export interface PaytmRefundRequestBody {
  mid: string;
  txnId: string; // Paytm TXNID to refund
  refId: string; // Our unique refund reference
  refundAmount: string; // e.g., "500.00"
  comments?: string;
}

export interface PaytmRefundResponseBody {
  refundId: string;
  txnId: string;
  orderId: string;
  refundAmount: string;
  currency: string;
  status: PaytmRefundState;
  resultInfo?: {
    resultStatus: string;
    resultCode: string;
    resultMsg: string;
  };
}

export type PaytmRefundResponse = PaytmResponse<PaytmRefundResponseBody>;

export type PaytmRefundState = 'ACCEPTED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'REVERSED';

// ---------------------------------------------------------------------------
// Refund Status API (getRefundStatus)
// POST /theia/api/v1/refundStatus
// ---------------------------------------------------------------------------

export interface PaytmRefundStatusRequestBody {
  mid: string;
  refId: string; // Our refund reference
}

export interface PaytmRefundStatusResponseBody {
  refundId: string;
  txnId: string;
  orderId: string;
  refundAmount: string;
  currency: string;
  status: PaytmRefundState;
}

export type PaytmRefundStatusResponse = PaytmResponse<PaytmRefundStatusResponseBody>;

// ---------------------------------------------------------------------------
// Webhook (NVP/URL-encoded format)
// ---------------------------------------------------------------------------

// Paytm webhooks arrive as application/x-www-form-urlencoded (NVP format).
// After parsing, fields include:
export interface PaytmWebhookPayload {
  MID?: string;
  ORDERID?: string;
  TXNID?: string;
  TXNAMOUNT?: string;
  CURRENCY?: string;
  STATUS?: string;
  RESPCODE?: string;
  RESPMSG?: string;
  PAYMENTMODE?: string;
  BANKNAME?: string;
  GATEWAYNAME?: string;
  TXNDATE?: string;
  CHECKSUMHASH?: string;
  [key: string]: string | undefined; // Allow additional NVP fields
}

// ---------------------------------------------------------------------------
// API Error
// ---------------------------------------------------------------------------

export interface PaytmApiError {
  head?: {
    responseTimestamp?: string;
  };
  body?: {
    resultInfo?: {
      resultStatus: string;
      resultCode: string;
      resultMsg: string;
    };
  };
}
