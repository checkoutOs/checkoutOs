// razorpay.types.ts
// Raw response shapes returned by the Razorpay API.
// These types are Razorpay-specific and must never leak outside the gateway folder.
// Services and controllers only ever see the unified types from gateway.types.ts.

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

// Razorpay requires an Order to be created before a payment can be initiated.
// createPayment() creates an order first, then returns the payment URL.

export interface RazorpayOrder {
  id: string; // order_XXXXXXXXXXXXXXXXXX
  entity: 'order';
  amount: number; // in paise
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string; // maps to our orderId
  status: RazorpayOrderStatus;
  attempts: number;
  created_at: number; // unix timestamp
}

export type RazorpayOrderStatus = 'created' | 'attempted' | 'paid';

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

export interface RazorpayPayment {
  id: string; // pay_XXXXXXXXXXXXXXXXXX
  entity: 'payment';
  amount: number; // in paise
  currency: string;
  status: RazorpayPaymentStatus;
  order_id: string; // order_XXXXXXXXXXXXXXXXXX
  description?: string;
  email?: string;
  contact?: string;
  created_at: number; // unix timestamp
  error_code?: string;
  error_description?: string;
}

// All native Razorpay payment status strings.
// GatewayMapper.toUnifiedStatus() maps each of these to PaymentStatus.

export type RazorpayPaymentStatus =
  | 'created' // maps to PENDING
  | 'authorized' // maps to PROCESSING
  | 'captured' // maps to SUCCESS
  | 'refunded' // maps to REFUNDED
  | 'failed'; // maps to FAILED

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

export interface RazorpayRefund {
  id: string; // rfnd_XXXXXXXXXXXXXXXXXX
  entity: 'refund';
  amount: number; // in paise
  currency: string;
  payment_id: string; // pay_XXXXXXXXXXXXXXXXXX - the parent payment
  status: RazorpayRefundStatus;
  speed_processed?: string;
  notes?: Record<string, string>;
  created_at: number; // unix timestamp
}

// All native Razorpay refund status strings.

export type RazorpayRefundStatus =
  | 'pending' // maps to RefundStatus.PENDING
  | 'processed' // maps to RefundStatus.SUCCESS
  | 'failed'; // maps to RefundStatus.FAILED

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

// Razorpay webhook payloads follow a consistent envelope structure.
// The event string determines which entity is present inside payload.

export interface RazorpayWebhookPayload {
  entity: 'event';
  account_id: string;
  event: RazorpayWebhookEvent;
  contains: string[]; // e.g. ['payment'] or ['refund']
  payload: {
    payment?: {
      entity: RazorpayPayment;
    };
    refund?: {
      entity: RazorpayRefund;
    };
  };
  created_at: number; // unix timestamp
}

// All Razorpay webhook event strings handled by checkoutOs V1.0.

export type RazorpayWebhookEvent =
  | 'payment.authorized'
  | 'payment.captured'
  | 'payment.failed'
  | 'refund.processed'
  | 'refund.failed';

// ---------------------------------------------------------------------------
// API Error
// ---------------------------------------------------------------------------

// Shape of the error object Razorpay returns on 4xx / 5xx responses.
// Used inside the plugin to throw typed errors.

export interface RazorpayApiError {
  error: {
    code: string;
    description: string;
    source?: string;
    step?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  };
}
