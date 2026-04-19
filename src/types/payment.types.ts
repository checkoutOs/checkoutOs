// payment.types.ts
// All payment and refund types

// Gateway identifier used by the unified gateway abstraction.
// Keep this type extensible so adding a new gateway does not require
// editing this core file; validation happens in config/env schema.
export type GatewayName = string;

// Every gateway native status strings are normalized to one of these.
// gateway.types.ts -> GatewayMapper.toUnifiedStatus()

export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export enum RefundStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

// V1.0 ONLY SUPPORTS INR.
export type Currency = 'INR';

// POST /payments - inbound request

export interface CreatePaymentRequest {
  amount: number; // amount in paise (50000 = 500.00)
  currency: Currency;
  orderId: string; // Developer's own order reference
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  description?: string;
  metadata?: Record<string, string>; // Arbitrary key-value passthrough
}

// POST /payments - outbound response

export interface PaymentResponse {
  paymentId: string; // chk_ prefixed - only ID ever exposed externally
  paymentUrl: string; /// checkoutOs hosted URL (/checkout/:chkId)
  status: PaymentStatus;
  amount: number;
  currency: Currency;
  gateway: GatewayName;
  orderId: string;
  createdAt: string; // ISO
}

// GET /payments/:chkId - outbound response

export interface PaymentStatusResponse {
  paymentId: string;
  status: PaymentStatus;
  amount: number;
  currency: Currency;
  gateway: GatewayName;
  orderId: string;
  createdAt: string;
  updatedAt: string;
}

// POST /payments/:chkId/refund - inbound request

export interface CreateRefundRequest {
  amount?: number; // optional: omit for full refund, provide for partial
  reason?: string;
}

export interface RefundResponse {
  refundId: string; // ref_ prefixed ID
  paymentId: string; // chk_ prefixed parent payment ID
  status: RefundStatus;
  amount: number;
  currency: Currency;
  gateway: GatewayName;
  createdAt: string;
}

// GET /refunds/:refId - outbound response

export interface RefundStatusResponse {
  refundId: string;
  paymentId: string;
  status: RefundStatus;
  amount: number;
  currency: Currency;
  gateway: GatewayName;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Redis store payment record
// chk:pay:{chk_id} hash — internal only, never returned to clients directly.
//
// Option C: two gateway ID fields are stored separately.
//
//   gatewayOrderId   — set at createPayment() time.
//                      For Razorpay: order_XXXX.
//                      For gateways that issue a single ID: same as gatewayPaymentId.
//
//   gatewayPaymentId — set after payment.captured webhook arrives.
//                      For Razorpay: pay_XXXX.
//                      Empty string until the webhook updates it.
//                      This is the ID passed to createRefund().
//
// Do not collapse these into one field — they serve different purposes:
//   gatewayOrderId   → used to poll order status before webhook arrives
//   gatewayPaymentId → used to initiate refunds after payment is confirmed
// ---------------------------------------------------------------------------

export interface StoredPayment {
  chkId: string;
  gatewayOrderId: string; // native order/session ID — set at creation
  gatewayPaymentId: string; // native payment ID — set after webhook, empty until then
  gateway: string;
  orderId: string; // developer's own order reference
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StoreRefund {
  refId: string;
  chkId: string; // parent payment chk_ ID
  gatewayRefundId: string; // native gateway refund ID
  gateway: GatewayName;
  amount: number;
  currency: Currency;
  status: RefundStatus;
  createdAt: string;
  updatedAt: string;
}
