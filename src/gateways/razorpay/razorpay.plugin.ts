// razorpay.plugin.ts
// Implements GatewayPlugin for Razorpay.

import crypto from 'crypto';
import axios, { AxiosInstance, AxiosError } from 'axios';

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
import type { GatewayName } from '../../types/payment.types';
import { PaymentStatus, StoredPayment } from '../../types/payment.types';

import {
  GatewayTimeoutError,
  GatewayUnavailableError,
  GatewayInvalidSignatureError,
  GatewayMappingError,
  RefundNotReadyError,
} from '../../errors/gateways.errors';
import { PaymentCreationFailedError } from '../../errors/payment.errors';

import { RazorpayMapper } from './razorpay.mapper';
import type {
  RazorpayOrder,
  RazorpayOrderStatus,
  RazorpayPayment,
  RazorpayPaymentStatus,
  RazorpayRefund,
  RazorpayWebhookPayload,
  RazorpayApiError,
} from './razorpay.types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Credentials and Config
// ---------------------------------------------------------------------------

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export interface RazorpayConfig {
  credentials: RazorpayCredentials;
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;

    if (typeof value === 'string') return value;

    if (Array.isArray(value)) {
      return value.find((v): v is string => typeof v === 'string');
    }
  }

  return undefined;
}

function serializeBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf-8');
  return JSON.stringify(body);
}

function isTimeoutError(err: unknown): boolean {
  return axios.isAxiosError(err) && err.code === 'ECONNABORTED';
}

// ✅ FIXED: Better error extraction with full logging
function extractRazorpayErrorReason(err: AxiosError): string {
  const data = err.response?.data as RazorpayApiError | undefined;

  // Log full error for debugging
  console.error('=== RAZORPAY API ERROR ===');
  console.error('Status:', err.response?.status);
  console.error('Status Text:', err.response?.statusText);
  console.error('URL:', err.config?.url);
  console.error('Method:', err.config?.method);
  console.error('Response Data:', JSON.stringify(data, null, 2));
  console.error('===========================');

  // Return descriptive error
  if (data?.error?.description) {
    return data.error.description;
  }
  if (data?.error?.reason) {
    return data.error.reason;
  }
  return `HTTP ${err.response?.status ?? 'unknown'}: ${err.response?.statusText ?? 'Unknown error'}`;
}

// ---------------------------------------------------------------------------
// RazorpayPlugin
// ---------------------------------------------------------------------------

export class RazorpayPlugin implements GatewayPlugin {
  readonly name: GatewayName = 'razorpay';

  private readonly creds: RazorpayCredentials;
  private readonly http: AxiosInstance;
  private readonly mapper: RazorpayMapper;

  constructor(config: RazorpayConfig) {
    this.creds = config.credentials;
    this.mapper = new RazorpayMapper();

    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: REQUEST_TIMEOUT_MS,
      auth: {
        username: config.credentials.keyId,
        password: config.credentials.keySecret,
      },
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  public async createPayment(params: CreatePaymentParams): Promise<GatewayPaymentResult> {
    const orderPayload: Record<string, unknown> = {
      amount: params.amount,
      currency: params.currency,
      receipt: params.orderId,
      payment_capture: 1,
      ...(params.metadata && { notes: params.metadata }),
    };

    let order: RazorpayOrder;

    try {
      const response = await this.http.post<RazorpayOrder>('/orders', orderPayload);
      order = response.data;
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new GatewayTimeoutError(this.name, 'createPayment');
      }
      if (axios.isAxiosError(err)) {
        throw new PaymentCreationFailedError(this.name, extractRazorpayErrorReason(err));
      }
      throw err;
    }

    const result = this.mapper.toPaymentResult(this.orderToPayment(order, params));

    return {
      ...result,
      gatewayId: order.id,
      gatewayOrderId: order.id,
    };
  }

  public async getPaymentStatus(gatewayId: string): Promise<GatewayPaymentResult> {
    let order: RazorpayOrder;

    try {
      const response = await this.http.get<RazorpayOrder>(
        `/orders/${encodeURIComponent(gatewayId)}`,
      );
      order = response.data;
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new GatewayTimeoutError(this.name, 'getPaymentStatus');
      }
      if (axios.isAxiosError(err)) {
        throw new GatewayUnavailableError(this.name, extractRazorpayErrorReason(err));
      }
      throw err;
    }

    const result = this.mapper.toPaymentResult(this.orderToPayment(order, undefined));

    return {
      ...result,
      gatewayId: order.id,
      gatewayOrderId: order.id,
    };
  }

  // ✅ FIXED: Added debug logging for refund
  public async createRefund(params: CreateRefundParams): Promise<GatewayRefundResult> {
    const refundPayload: Record<string, unknown> = {};

    if (params.amount !== undefined) {
      refundPayload.amount = params.amount;
    }

    if (params.reason !== undefined) {
      refundPayload.notes = { reason: params.reason };
    }

    // ✅ DEBUG: Log what we're sending
    console.log('=== CREATE REFUND REQUEST ===');
    console.log('gatewayPaymentId:', params.gatewayPaymentId);
    console.log('amount:', params.amount ?? 'full');
    console.log(
      'URL:',
      `${this.http.defaults.baseURL}/payments/${params.gatewayPaymentId}/refunds`,
    );
    console.log('==============================');

    let refund: RazorpayRefund;

    try {
      const response = await this.http.post<RazorpayRefund>(
        `/payments/${encodeURIComponent(params.gatewayPaymentId)}/refunds`,
        refundPayload,
      );
      refund = response.data;
      console.log('✅ Refund created:', refund.id);
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new GatewayTimeoutError(this.name, 'createRefund');
      }
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const data = err.response?.data as { message?: string } | undefined;

        // Check for the specific settlement delay 404
        const isSettlementDelay =
          status === 404 && data?.message === 'no Route matched with those values';

        if (isSettlementDelay) {
          // Throw friendly error instead of generic GatewayUnavailableError
          throw new RefundNotReadyError(this.name, 60);
        }

        // All other HTTP errors
        throw new GatewayUnavailableError(this.name, extractRazorpayErrorReason(err));
      }
      throw err;
    }

    return this.mapper.toRefundResult(refund);
  }

  public async getRefundStatus(gatewayRefundId: string): Promise<GatewayRefundResult> {
    let refund: RazorpayRefund;

    try {
      const response = await this.http.get<RazorpayRefund>(
        `/refunds/${encodeURIComponent(gatewayRefundId)}`,
      );
      refund = response.data;
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new GatewayTimeoutError(this.name, 'getRefundStatus');
      }
      if (axios.isAxiosError(err)) {
        throw new GatewayUnavailableError(this.name, extractRazorpayErrorReason(err));
      }
      throw err;
    }

    return this.mapper.toRefundResult(refund);
  }

  public parseWebhookEvent(
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const signature = extractHeader(headers, 'x-razorpay-signature');
    if (!signature) {
      throw new GatewayInvalidSignatureError(this.name);
    }

    const rawBody = serializeBody(body);

    const expected = crypto
      .createHmac('sha256', this.creds.webhookSecret)
      .update(rawBody)
      .digest('hex');

    const sigBuffer = Buffer.from(signature, 'hex');
    const expBuffer = Buffer.from(expected, 'hex');

    if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
      throw new GatewayInvalidSignatureError(this.name);
    }

    let webhook: RazorpayWebhookPayload;
    try {
      webhook = JSON.parse(rawBody) as RazorpayWebhookPayload;
    } catch {
      throw new GatewayMappingError('Invalid JSON in webhook body', this.name);
    }

    const { event } = webhook;
    const paymentEntity = webhook?.payload?.payment?.entity;

    if (!paymentEntity) {
      throw new GatewayMappingError(`Missing payment.entity for event: ${event}`, this.name);
    }

    const gatewayPaymentId = paymentEntity.id ?? '';

    if (!gatewayPaymentId) {
      throw new GatewayMappingError(
        `Payment entity missing 'id' field for event: ${event}`,
        this.name,
      );
    }

    const status = this.mapWebhookEventToStatus(event, paymentEntity);
    const amount = paymentEntity.amount ?? 0;
    const currency = paymentEntity.currency ?? 'INR';

    return {
      gateway: this.name,
      gatewayPaymentId,
      event,
      status,
      amount,
      currency: currency as 'INR',
      raw: body,
    };
  }

  public async healthCheck(): Promise<GatewayHealthResult> {
    const start = Date.now();

    try {
      await this.http.get('/orders', {
        params: { count: 1, skip: 0 },
        validateStatus: (): boolean => true,
      });

      return { healthy: true, latencyMs: Date.now() - start };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }

  public getCheckoutAction(payment: StoredPayment): CheckoutAction {
    return {
      type: 'render',
      templateData: {
        chkId: payment.chkId,
        gatewayOrderId: payment.gatewayOrderId,
        amount: payment.amount,
        currency: payment.currency,
        keyId: this.creds.keyId,
      },
    };
  }

  private mapWebhookEventToStatus(
    event: string,
    paymentEntity: RazorpayPayment | undefined,
  ): PaymentStatus {
    switch (event) {
      case 'payment.authorized':
        return PaymentStatus.PROCESSING;
      case 'payment.captured':
        return PaymentStatus.SUCCESS;
      case 'payment.failed':
        return PaymentStatus.FAILED;
      case 'refund.processed': {
        const total = paymentEntity?.amount ?? 0;
        const refunded = (paymentEntity as unknown as Record<string, unknown>)?.amount_refunded;
        const refundedAmount = typeof refunded === 'number' ? refunded : 0;

        if (total > 0 && refundedAmount > 0 && refundedAmount < total) {
          return PaymentStatus.PARTIALLY_REFUNDED;
        }
        return PaymentStatus.REFUNDED;
      }
      case 'refund.failed':
        return PaymentStatus.SUCCESS;
      default:
        return PaymentStatus.PROCESSING;
    }
  }

  private orderToPayment(
    order: RazorpayOrder,
    params: CreatePaymentParams | undefined,
  ): RazorpayPayment {
    return {
      id: order.id,
      entity: 'payment',
      amount: order.amount,
      currency: order.currency,
      status: this.mapOrderStatusToPaymentStatus(order.status),
      order_id: order.id,
      created_at: order.created_at,
      ...(params?.description !== undefined && { description: params.description }),
      ...(params?.customerEmail !== undefined && { email: params.customerEmail }),
      ...(params?.customerPhone !== undefined && { contact: params.customerPhone }),
    };
  }

  private mapOrderStatusToPaymentStatus(orderStatus: RazorpayOrderStatus): RazorpayPaymentStatus {
    switch (orderStatus) {
      case 'created':
        return 'created';
      case 'attempted':
        return 'authorized';
      case 'paid':
        return 'captured';
      default: {
        const _exhaustive: never = orderStatus;
        throw new Error(`Unhandled RazorpayOrderStatus: ${String(_exhaustive)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export function createRazorpayPlugin(config: RazorpayConfig): GatewayPlugin {
  return new RazorpayPlugin(config);
}
