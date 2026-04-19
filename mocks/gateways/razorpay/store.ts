// In-memory store for mock Razorpay gateway

// ======================
// Order
// ======================

export interface StoredOrder {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  offer_id: null;
  status: 'created' | 'paid' | 'attempted';
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

export const orderStore = new Map<string, StoredOrder>();

// ======================
// Payment
// ======================

export interface StoredPayment {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: 'created' | 'captured' | 'failed';
  order_id: string;

  refunded_amount: number;
}

export const paymentStore = new Map<string, StoredPayment>();

// ======================
// Refund
// ======================

export interface StoredRefund {
  id: string;
  entity: 'refund';
  amount: number;
  currency: string;
  payment_id: string;
  status: 'processed';
  created_at: number;
}

export const refundStore = new Map<string, StoredRefund>();

// ======================
// Payment Simulation
// ======================

export function markOrderPaid(orderId: string): string | null {
  const order = orderStore.get(orderId);

  if (!order) return null;

  if (order.status === 'paid') {
    return `pay_${orderId.slice(6)}`;
  }

  order.status = 'paid';
  order.amount_paid = order.amount;
  order.amount_due = 0;

  const paymentId = `pay_${orderId.slice(6)}`;

  const payment: StoredPayment = {
    id: paymentId,
    entity: 'payment',
    amount: order.amount,
    currency: order.currency,
    status: 'captured',
    order_id: orderId,

    refunded_amount: 0,
  };

  paymentStore.set(paymentId, payment);

  return paymentId;
}
