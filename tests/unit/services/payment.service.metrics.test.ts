// tests/unit/services/payment.service.metrics.test.ts
// Metrics recorded by the payment service (ADR 003 §6.2).
//
// Business invariants protected:
//   - a poll that sees SUCCESS is suppressed (webhook-only) AND counted in
//     gateway.poll_success_suppressed — the alert that money is captured but
//     webhooks are not arriving. The one metric verify:telemetry cannot reach.
//   - a status change from polling counts as payment.transitions{source=poll}
//   - an unchanged poll records no transition

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installTestMeterProvider } from '../../helpers/metrics.helper';
import { PaymentStatus } from '../../../src/types/payment.types';
import type { StoredPayment } from '../../../src/types/payment.types';

const { delta } = installTestMeterProvider();

vi.mock('../../../src/store/payment.store', () => ({
  savePayment: vi.fn(),
  findPaymentByChkId: vi.fn(),
  updatePaymentStatus: vi.fn().mockResolvedValue(undefined),
  findPaymentByOrderId: vi.fn(),
  reserveOrderId: vi.fn(),
}));

vi.mock('../../../src/store/refund.store', () => ({
  findRefundsByChkId: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/gateways/gateway.registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/gateways/gateway.registry')>()),
  getActiveGateway: vi.fn(),
}));

import { getPaymentStatus } from '../../../src/services/payments.service';
import { findPaymentByChkId } from '../../../src/store/payment.store';
import { getActiveGateway } from '../../../src/gateways/gateway.registry';

const pollGateway = { getPaymentStatus: vi.fn() };

function stalePayment(status: PaymentStatus): StoredPayment {
  return {
    chkId: 'chk_1',
    gatewayOrderId: 'order_1',
    gatewayPaymentId: '',
    gateway: 'razorpay',
    orderId: 'ORD-1',
    amount: 50000,
    currency: 'INR',
    status,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(), // stale → re-poll
  } as StoredPayment;
}

function gatewayReports(status: PaymentStatus): void {
  pollGateway.getPaymentStatus.mockResolvedValue({
    gatewayId: 'order_1',
    status,
    amount: 50000,
    currency: 'INR',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveGateway).mockReturnValue(pollGateway as never);
  vi.mocked(findPaymentByChkId).mockResolvedValue(stalePayment(PaymentStatus.PENDING));
});

describe('getPaymentStatus metrics', () => {
  it('counts a suppressed SUCCESS poll, and records no transition', async () => {
    gatewayReports(PaymentStatus.SUCCESS);

    const suppressed = await delta(
      'gateway.poll_success_suppressed',
      { gateway: 'razorpay' },
      async () => {
        const result = await getPaymentStatus('chk_1');
        expect(result.status).toBe(PaymentStatus.PENDING);
      },
    );

    expect(suppressed).toBe(1);
    expect(
      await delta('payment.transitions', { source: 'poll' }, () => getPaymentStatus('chk_1')),
    ).toBe(0);
  });

  it('counts a polled status change as a poll transition', async () => {
    gatewayReports(PaymentStatus.FAILED);

    expect(
      await delta(
        'payment.transitions',
        { gateway: 'razorpay', from: 'PENDING', to: 'FAILED', source: 'poll' },
        () => getPaymentStatus('chk_1'),
      ),
    ).toBe(1);
  });

  it('records nothing when the poll sees the same status', async () => {
    gatewayReports(PaymentStatus.PENDING);

    expect(await delta('payment.transitions', {}, () => getPaymentStatus('chk_1'))).toBe(0);
    expect(
      await delta('gateway.poll_success_suppressed', {}, () => getPaymentStatus('chk_1')),
    ).toBe(0);
  });
});
