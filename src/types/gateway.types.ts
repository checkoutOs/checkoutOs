// gateway.types.ts
//  Interfaces and types that define the gateway plugin contract.
// Every gateway adapter (Razorpay, PayU, Cashfree) must conform to these.
//  Nothing in this file ever return to API clients directly
// services translate these into payment.types.ts shape first

import { GatewayName, PaymentStatus, RefundStatus, Currency } from './payment.types';

// createPayment() input

// Passed from PaymentServices -> GatewayPlugin.createPayment()

export interface CreatePaymentParams {
  orderId: string;
  amount: number; // In paise
  currency: Currency;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  description?: string;
  metadata?: Record<string, string>;
}

// -- createRefund() input

//  Passsed from RefundService -> GatewayPlugin.createRefund()

export interface CreateRefundParams {
  gatewayPaymentId: string; // Native gateway ID - not the chk_ ID
  amount: number; // Amount to refund in paise
  reason?: string;
}

//  Normalized gateway payment result
//  What every GatewayPlugin method return after normalization via mapper
// The mapper is responsible for translating raw gateway responses into this.

export interface GatewayPaymentResult {
  gatewayId: string; // From  Native gateway
  status: PaymentStatus; // Normalized via GatewayMapper.toUnifiedStatus()
  amount: number;
  currency: Currency;
  gatewayOrderId?: string; // some gateway like Razorpay use an order Id
  raw?: unknown; // Original gateway response - dubug only
}

// -- Normalized gateway refund result

export interface GatewayRefundResult {
  gatewayRefundId: string; // Native gateway refundId
  gatewayPaymentId: string; // Native gateway payment ID this refund belongs
  status: RefundStatus;
  amount: number;
  currency: Currency;
  raw?: unknown;
}

//  Normalized webhook event

// output of GatewayPlugin.parseWebhookEvent()

//  The webhook controller uses gatewayPaymentId to look up the chk_ ID in in Redsi.

export interface WebhookEvent {
  gateway: GatewayName;
  gatewayPaymentId: string; // use for Redis reverse look to find chk_
  event: string;
  status: PaymentStatus;
  amount: number;
  currency: Currency;
  raw: unknown; // original payload
}

// Gateway health check result

export interface GatewayHealthResult {
  healthy: boolean;
  latencyMs: number;
}

// GatewayPlugin interface
// Every gateway must implement all of these methods. Service only ever call GatewayPlugin - never gateway SDK directly.

export interface GatewayPlugin {
  readonly name: GatewayName;

  // Create a payment on the gateway
  // return a GatewayPaymentResult that always includes a paymetnUrl

  createPayment(params: CreatePaymentParams): Promise<GatewayPaymentResult>;

  // Fetch current payment staus from the gateway by native gateway ID

  getPaymentStatus(gatewayId: string): Promise<GatewayPaymentResult>;

  // Initiate a full or partial refund on the gateway
  createRefund(params: CreateRefundParams): Promise<GatewayRefundResult>;

  //  Fetch current refund status form teh gateway by native refund ID

  getRefundStatus(gatewayRefundId: string): Promise<GatewayRefundResult>;

  // Parse and validate an inbound webhook payload and signature/validation
  // data derived from the provided raw HTTP headers. Throws on invalid
  // signature (or other irrecoverable webhook format issues).
  parseWebhookEvent(
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent;

  // ping gateway to verify credentials and connectivity, use in initial getup validatoin and GET

  healthCheck(): Promise<GatewayHealthResult>;
}

export interface GatewayMapper<TRawPayment, TRawRefund> {
  // Translates a raw gateway paymetn object to a normalized GatewayPaymentResult.
  toPaymentResult(raw: TRawPayment): GatewayPaymentResult;

  // Translate a raw gateway refund object to normalized GatewayRefundResult

  toRefundResult(raw: TRawRefund): GatewayRefundResult;

  /**
   * Maps a gateway-native status string to the unified PaymentStatus enum.
   * This is the most critical method — status mismatches cause silent bugs.
   */
  toUnifiedStatus(gatewayStatus: string): PaymentStatus;
}
