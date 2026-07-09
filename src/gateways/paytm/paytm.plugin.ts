// src/gateways/paytm/paytm.plugin.ts
// Implements GatewayPlugin for Paytm.
//
// Paytm uses a nested request envelope { head: { signature }, body: { ... } }
// and requires a checksum signature on every API call.
// Webhooks arrive as URL-encoded (NVP) format with CHECKSUMHASH verification.

import axios, { AxiosInstance, AxiosError } from 'axios';
import * as PaytmChecksum from 'paytmchecksum';

import type {
  CreatePaymentParams,
  CreateRefundParams,
  GatewayHealthResult,
  GatewayPaymentResult,
  GatewayPlugin,
  GatewayRefundResult,
  WebhookEvent,
  CheckoutAction,
} from '../../types/gateway.types';
import type { GatewayName, StoredPayment } from '../../types/payment.types';
import { PaymentStatus } from '../../types/payment.types';

import {
  GatewayTimeoutError,
  GatewayUnavailableError,
  GatewayInvalidSignatureError,
  GatewayMappingError,
  RefundNotReadyError,
} from '../../errors/gateways.errors';
import { PaymentCreationFailedError } from '../../errors/payment.errors';
import { PaytmPhoneRequiredError, PaytmWebhookParseError } from '../../errors/paytm.errors';

import { PaytmMapper } from './paytm.mapper';
import { createContextLogger } from '../../utils/logger';

const log = createContextLogger('paytm-plugin');
import type {
  PaytmRequest,
  PaytmSendPaymentRequestBody,
  PaytmSendPaymentResponse,
  PaytmTransactionStatusRequestBody,
  PaytmTransactionStatusResponse,
  PaytmRefundRequestBody,
  PaytmRefundResponse,
  PaytmWebhookPayload,
  PaytmApiError,
} from './paytm.types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Credentials and Config
// ---------------------------------------------------------------------------

export interface PaytmCredentials {
  merchantId: string;
  merchantKey: string;
  webhookSecret: string;
}

export interface PaytmConfig {
  credentials: PaytmCredentials;
  baseUrl: string;
  // Paytm website name — identifies the checkout environment.
  // Defaults to 'WEBSTAGING' (sandbox). Set to 'DEFAULT' in production
  // or to the custom name assigned by Paytm for your merchant account.
  websiteName?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Build the checksum-signed request envelope for Paytm API calls.
// Paytm requires every request to have a signature in the head.
function buildPaytmRequest<T>(body: T, merchantKey: string): PaytmRequest<T> {
  const signature = PaytmChecksum.generateSignature(body as Record<string, unknown>, merchantKey);

  return {
    head: {
      signature,
    },
    body,
  };
}

// Generate a unique refund reference ID.
// Paytm requires a unique refId for each refund request.
function generateRefId(orderId: string): string {
  const timestamp = Date.now().toString(36); // base36 timestamp for compactness
  const random = Math.random().toString(36).substring(2, 8); // 6 random chars
  return `ref_${orderId}_${timestamp}_${random}`;
}

// Parse URL-encoded (NVP) body into a PaytmWebhookPayload object.
// Paytm webhooks arrive as application/x-www-form-urlencoded.
function parseNvpBody(body: unknown): PaytmWebhookPayload {
  if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
    // If body is already parsed (e.g., by express.urlencoded), use it directly
    const obj = body as Record<string, unknown>;
    const payload: PaytmWebhookPayload = {};
    for (const [key, value] of Object.entries(obj)) {
      payload[key] = typeof value === 'string' ? value : String(value ?? '');
    }
    return payload;
  }

  // If body is a string or Buffer, it should be URL-encoded
  throw new PaytmWebhookParseError(
    'Webhook body is not a parsed object. ' +
      'Ensure express.urlencoded({ extended: true }) middleware is mounted for the Paytm webhook route.',
  );
}

function isTimeoutError(err: unknown): boolean {
  return axios.isAxiosError(err) && err.code === 'ECONNABORTED';
}

// Extract error reason from Paytm API error responses.
function extractPaytmErrorReason(err: AxiosError): string {
  const data = err.response?.data as PaytmApiError | undefined;

  log.error('Paytm API error', {
    status: err.response?.status,
    statusText: err.response?.statusText,
    url: err.config?.url,
    method: err.config?.method,
    responseData: data,
  });

  if (data?.body?.resultInfo?.resultMsg) {
    return `${data.body.resultInfo.resultCode}: ${data.body.resultInfo.resultMsg}`;
  }
  return `HTTP ${err.response?.status ?? 'unknown'}: ${err.response?.statusText ?? 'Unknown error'}`;
}

// ---------------------------------------------------------------------------
// PaytmPlugin
// ---------------------------------------------------------------------------

export class PaytmPlugin implements GatewayPlugin {
  readonly name: GatewayName = 'paytm';

  private readonly creds: PaytmCredentials;
  private readonly http: AxiosInstance;
  private readonly mapper: PaytmMapper;
  private readonly webhookSecret: string;
  private readonly websiteName: string;

  constructor(config: PaytmConfig) {
    this.creds = config.credentials;
    this.mapper = new PaytmMapper();
    // Webhook secret falls back to merchant key if not explicitly set
    this.webhookSecret = config.credentials.webhookSecret || config.credentials.merchantKey;
    // Website name defaults to 'WEBSTAGING' for sandbox; must be overridden for production
    this.websiteName = config.websiteName ?? 'WEBSTAGING';

    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // ---------------------------------------------------------------------------
  // createPayment
  // ---------------------------------------------------------------------------
  // Paytm requires customerPhone to send the SMS payment link via their
  // Send Payment Request API. Throws PaytmPhoneRequiredError if missing.

  public async createPayment(params: CreatePaymentParams): Promise<GatewayPaymentResult> {
    // Phone number is mandatory for Paytm
    if (!params.customerPhone || params.customerPhone.trim() === '') {
      throw new PaytmPhoneRequiredError();
    }

    const body: PaytmSendPaymentRequestBody = {
      requestType: 'Payment',
      mid: this.creds.merchantId,
      websiteName: this.websiteName,
      orderId: params.orderId,
      txnAmount: {
        value: this.mapper.formatAmountRupees(params.amount),
        currency: params.currency,
      },
      userInfo: {
        custId: params.customerName ?? params.orderId,
        mobile: params.customerPhone,
        // Only include email if it's defined
        ...(params.customerEmail !== undefined && { email: params.customerEmail }),
      },
    };

    const request = buildPaytmRequest(body, this.creds.merchantKey);

    let response: PaytmSendPaymentResponse;

    try {
      const httpResponse = await this.http.post<PaytmSendPaymentResponse>(
        '/theia/api/v1/initiateTransaction',
        request,
      );
      response = httpResponse.data;
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new GatewayTimeoutError(this.name, 'createPayment');
      }
      if (axios.isAxiosError(err)) {
        throw new PaymentCreationFailedError(this.name, extractPaytmErrorReason(err));
      }
      throw err;
    }

    const resultInfo = response.body?.resultInfo;

    if (resultInfo?.resultStatus !== 'S') {
      throw new PaymentCreationFailedError(
        this.name,
        `${resultInfo?.resultCode ?? 'UNKNOWN'}: ${resultInfo?.resultMsg ?? 'Unknown error'}`,
      );
    }

    const paymentUrl = response.body?.paymentUrl ?? response.body?.redirectUrl ?? '';

    return {
      gatewayId: response.body.orderId, // ORDERID is the initial gateway ID
      status: PaymentStatus.PENDING,
      amount: params.amount,
      currency: params.currency,
      gatewayOrderId: response.body.orderId,
      paymentUrl,
      raw: response,
    };
  }

  // ---------------------------------------------------------------------------
  // getPaymentStatus
  // ---------------------------------------------------------------------------
  // Calls Paytm Transaction Status API to check payment state.

  public async getPaymentStatus(gatewayId: string): Promise<GatewayPaymentResult> {
    const body: PaytmTransactionStatusRequestBody = {
      mid: this.creds.merchantId,
      orderId: gatewayId,
    };

    const request = buildPaytmRequest(body, this.creds.merchantKey);

    let response: PaytmTransactionStatusResponse;

    try {
      const httpResponse = await this.http.post<PaytmTransactionStatusResponse>(
        '/theia/api/v1/transactionStatus',
        request,
      );
      response = httpResponse.data;
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new GatewayTimeoutError(this.name, 'getPaymentStatus');
      }
      if (axios.isAxiosError(err)) {
        throw new GatewayUnavailableError(this.name, extractPaytmErrorReason(err));
      }
      throw err;
    }

    return this.mapper.toPaymentResult(response);
  }

  // ---------------------------------------------------------------------------
  // createRefund
  // ---------------------------------------------------------------------------
  // Initiates a refund on Paytm. Detects settlement delay errors and throws
  // RefundNotReadyError so the caller can retry later.

  public async createRefund(params: CreateRefundParams): Promise<GatewayRefundResult> {
    const refId = generateRefId(params.gatewayPaymentId);

    const body: PaytmRefundRequestBody = {
      mid: this.creds.merchantId,
      txnId: params.gatewayPaymentId,
      refId,
      refundAmount: this.mapper.formatAmountRupees(params.amount),
      ...(params.reason && { comments: params.reason }),
    };

    const request = buildPaytmRequest(body, this.creds.merchantKey);

    log.info('Creating Paytm refund', {
      txnId: params.gatewayPaymentId,
      refId,
      amountPaise: params.amount,
      amountRupees: this.mapper.formatAmountRupees(params.amount),
      url: `${this.http.defaults.baseURL}/theia/api/v1/refundTransaction`,
    });

    let response: PaytmRefundResponse;

    try {
      const httpResponse = await this.http.post<PaytmRefundResponse>(
        '/theia/api/v1/refundTransaction',
        request,
      );
      response = httpResponse.data;
      log.info('Paytm refund created', { refundId: response.body?.refundId });
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new GatewayTimeoutError(this.name, 'createRefund');
      }
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const data = err.response?.data as PaytmApiError | undefined;

        // Check for settlement delay — Paytm returns specific result codes
        const resultCode = data?.body?.resultInfo?.resultCode;
        const resultMsg = data?.body?.resultInfo?.resultMsg ?? '';

        const isSettlementDelay =
          status === 400 &&
          (resultCode === '501' ||
            resultMsg.toLowerCase().includes('not settled') ||
            resultMsg.toLowerCase().includes('settlement'));

        if (isSettlementDelay) {
          throw new RefundNotReadyError(this.name, 120);
        }

        throw new GatewayUnavailableError(this.name, extractPaytmErrorReason(err));
      }
      throw err;
    }

    return this.mapper.toRefundResult(response);
  }

  // ---------------------------------------------------------------------------
  // getRefundStatus
  // ---------------------------------------------------------------------------
  // Paytm does not support polling refund status via API.
  // Refund status updates come only through webhooks.
  // Throwing GatewayUnavailableError per Integration Plan §9.10 method 4.

  public async getRefundStatus(_gatewayRefundId: string): Promise<GatewayRefundResult> {
    throw new GatewayUnavailableError(
      this.name,
      'Paytm does not support polling refund status. Refund status updates arrive via webhooks only.',
    );
  }

  // ---------------------------------------------------------------------------
  // parseWebhookEvent
  // ---------------------------------------------------------------------------
  // Parses Paytm webhook (URL-encoded NVP format) and verifies CHECKSUMHASH.
  //
  // Flow:
  //   1. Parse NVP body into PaytmWebhookPayload
  //   2. Extract CHECKSUMHASH
  //   3. Remove CHECKSUMHASH from object for verification
  //   4. Verify checksum via PaytmChecksum.verifySignature()
  //   5. Extract core fields (TXNID, ORDERID, STATUS, RESPCODE)
  //   6. Map to unified status via mapper.mapWebhookToPaymentStatus()

  public parseWebhookEvent(
    body: unknown,
    _headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    // Step 1: Parse NVP body
    const payload = parseNvpBody(body);

    // Step 2: Extract CHECKSUMHASH
    const checksum = payload.CHECKSUMHASH;
    if (!checksum) {
      throw new GatewayInvalidSignatureError(this.name);
    }

    // Step 3: Remove CHECKSUMHASH for verification
    // Use spread + delete to avoid unused variable lint warning
    const bodyWithoutChecksum = { ...payload };
    delete bodyWithoutChecksum.CHECKSUMHASH;

    // Step 4: Verify checksum
    // Note: paytmchecksum library handles both string and object inputs.
    // We pass the object directly; the library internally converts it.
    const isValid = PaytmChecksum.verifySignature(
      bodyWithoutChecksum as Record<string, unknown>,
      this.webhookSecret,
      checksum,
    );

    if (!isValid) {
      throw new GatewayInvalidSignatureError(this.name);
    }

    // Step 5: Extract core fields
    const gatewayPaymentId = payload.TXNID ?? '';
    const status = payload.STATUS ?? '';
    const respCode = payload.RESPCODE ?? '';
    const amountStr = payload.TXNAMOUNT ?? '0';
    const currency = (payload.CURRENCY ?? 'INR') as 'INR';

    if (!gatewayPaymentId) {
      throw new GatewayMappingError('Missing TXNID in Paytm webhook payload', this.name);
    }

    if (!status) {
      throw new GatewayMappingError('Missing STATUS in Paytm webhook payload', this.name);
    }

    // Step 6: Map status using the complete STATUS + RESPCODE matrix
    const unifiedStatus = this.mapper.mapWebhookToPaymentStatus(status, respCode);

    // Convert amount from rupees string (e.g., "500.00") to paise integer (50000)
    const amountInPaise = this.mapper.parseAmountToPaise(amountStr);

    return {
      gateway: this.name,
      gatewayPaymentId,
      // Populate gatewayOrderId so webhook.service can use ORDERID as a fallback
      // lookup key when TXNID is not yet in Redis (first webhook scenario).
      ...(payload.ORDERID !== undefined && { gatewayOrderId: payload.ORDERID }),
      event: status,
      status: unifiedStatus,
      amount: amountInPaise,
      currency,
      raw: body,
    };
  }

  // ---------------------------------------------------------------------------
  // getCheckoutAction
  // ---------------------------------------------------------------------------
  // Paytm is redirect-based — returns a 302 redirect to the payment URL.
  //
  // Primary path: read paymentUrl from gatewayMetadata (written during createPayment).
  //   Paytm's initiateTransaction response includes the exact URL — storing it
  //   in gatewayMetadata at creation time means no network call is needed here.
  //
  // Fallback path: reconstruct from gatewayOrderId.
  //   Handles records created before the gatewayMetadata field was introduced.

  public getCheckoutAction(payment: StoredPayment): CheckoutAction {
    const url =
      payment.gatewayMetadata?.['paymentUrl'] ??
      `${this.http.defaults.baseURL}/theia/api/v1/showPaymentPage?mid=${this.creds.merchantId}&orderId=${encodeURIComponent(payment.gatewayOrderId)}`;

    return { type: 'redirect', url };
  }

  // ---------------------------------------------------------------------------
  // healthCheck
  // ---------------------------------------------------------------------------
  // Paytm has no lightweight ping endpoint.
  // Per Integration Plan §4.3: call transaction status with dummy ORDERID.
  // A structured error response (HTTP 4xx with Paytm body) = healthy.
  // Only network errors, timeouts, or connection failures = unhealthy.

  public async healthCheck(): Promise<GatewayHealthResult> {
    const start = Date.now();

    try {
      const body: PaytmTransactionStatusRequestBody = {
        mid: this.creds.merchantId,
        orderId: 'HEALTH_CHECK_DUMMY_ORDER',
      };

      const request = buildPaytmRequest(body, this.creds.merchantKey);

      await this.http.post('/theia/api/v1/transactionStatus', request, {
        validateStatus: (status: number): boolean => status < 500, // Accept 4xx as healthy
      });

      return { healthy: true, latencyMs: Date.now() - start };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export function createPaytmPlugin(config: PaytmConfig): GatewayPlugin {
  return new PaytmPlugin(config);
}
