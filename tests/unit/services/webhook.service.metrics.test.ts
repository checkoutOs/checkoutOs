// tests/unit/services/webhook.service.metrics.test.ts
// Metrics recorded by processWebhook (ADR 003 §6.2, §6.3).
//
// Business invariants protected:
//   - webhook.processing.duration EXCLUDES the merchant relay — a slow
//     merchant endpoint must not show up as slow webhook processing
//   - webhook.relay.duration measures the relay on its own
//   - every delivery lands in webhook.received with the right result:
//     updated / unchanged / blocked / unknown_payment / rejected
//   - blocked transitions and unknown payments get their own counters
//   - relay outcomes: success / http_error / timeout / network_error

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installTestMeterProvider } from '../../helpers/metrics.helper';
import { PaymentStatus } from '../../../src/types/payment.types';
import type { StoredPayment } from '../../../src/types/payment.types';
import type { WebhookEvent } from '../../../src/types/gateway.types';
import { GatewayInvalidSignatureError } from '../../../src/errors';

const { total, sum, delta } = installTestMeterProvider();

vi.mock('../../../src/store/payment.store', () => ({
  findChkIdByGatewayId: vi.fn(),
  findPaymentByChkId: vi.fn(),
  updatePaymentStatus: vi.fn().mockResolvedValue(undefined),
  updateGatewayPaymentId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/gateways/gateway.registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/gateways/gateway.registry')>()),
  getActiveGateway: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    isAxiosError: (err: unknown): boolean =>
      typeof err === 'object' && err !== null && 'isAxiosError' in err,
  },
}));

import { processWebhook } from '../../../src/services/webhook.service';
import { findChkIdByGatewayId, findPaymentByChkId } from '../../../src/store/payment.store';
import { getActiveGateway } from '../../../src/gateways/gateway.registry';
import axios from 'axios';

const EVENT: WebhookEvent = {
  gateway: 'razorpay',
  gatewayPaymentId: 'pay_1',
  event: 'payment.captured',
  status: PaymentStatus.SUCCESS,
  amount: 50000,
  currency: 'INR',
  raw: {},
};

function stored(status: PaymentStatus, gatewayPaymentId = 'pay_1'): StoredPayment {
  return {
    chkId: 'chk_1',
    gatewayOrderId: 'order_1',
    gatewayPaymentId,
    gateway: 'razorpay',
    orderId: 'ORD-1',
    amount: 50000,
    currency: 'INR',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as StoredPayment;
}

function gatewayReturns(event: WebhookEvent | Error): void {
  vi.mocked(getActiveGateway).mockReturnValue({
    parseWebhookEvent: (): WebhookEvent => {
      if (event instanceof Error) throw event;
      return event;
    },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  gatewayReturns(EVENT);
  vi.mocked(findChkIdByGatewayId).mockResolvedValue('chk_1');
  vi.mocked(findPaymentByChkId).mockResolvedValue(stored(PaymentStatus.PENDING));
  vi.mocked(axios.post).mockResolvedValue({ status: 200 });
});

const process = (): Promise<void> => processWebhook('razorpay', '{}', {});

describe('webhook timing', () => {
  it('excludes a slow relay from processing time, and measures it separately', async () => {
    vi.mocked(axios.post).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), 250)),
    );
    const processingBefore = await sum('webhook.processing.duration');
    const relayBefore = await sum('webhook.relay.duration');

    await process();

    const processing = (await sum('webhook.processing.duration')) - processingBefore;
    const relay = (await sum('webhook.relay.duration')) - relayBefore;
    expect(relay).toBeGreaterThanOrEqual(0.2);
    expect(processing).toBeLessThan(0.1);
  });

  it('records processing time even when the webhook is rejected', async () => {
    gatewayReturns(new GatewayInvalidSignatureError('razorpay'));

    expect(await delta('webhook.processing.duration', { gateway: 'razorpay' }, process)).toBe(1);
  });
});

describe('webhook.received result', () => {
  const received = (result: string, event = 'payment.captured'): Record<string, string> => ({
    gateway: 'razorpay',
    event,
    result,
  });

  it('updated — status transitioned, and counted as a webhook transition', async () => {
    expect(await delta('webhook.received', received('updated'), process)).toBe(1);
    expect(
      await total('payment.transitions', {
        from: 'PENDING',
        to: 'SUCCESS',
        source: 'webhook',
      }),
    ).toBeGreaterThan(0);
  });

  it('unchanged — same status, ID already set', async () => {
    vi.mocked(findPaymentByChkId).mockResolvedValue(stored(PaymentStatus.SUCCESS));

    expect(await delta('webhook.received', received('unchanged'), process)).toBe(1);
  });

  it('blocked — counted in payment.transitions_blocked with from/to', async () => {
    gatewayReturns({ ...EVENT, event: 'payment.failed', status: PaymentStatus.FAILED });
    vi.mocked(findPaymentByChkId).mockResolvedValue(stored(PaymentStatus.SUCCESS));

    const blocked = { gateway: 'razorpay', from: 'SUCCESS', to: 'FAILED', source: 'webhook' };
    expect(await delta('payment.transitions_blocked', blocked, process)).toBe(1);
    expect(await total('webhook.received', received('blocked', 'payment.failed'))).toBe(1);
  });

  it('unknown_payment — also counted in webhook.unknown_payment, no relay', async () => {
    vi.mocked(findChkIdByGatewayId).mockResolvedValue(null);

    expect(await delta('webhook.unknown_payment', { gateway: 'razorpay' }, process)).toBe(1);
    expect(await total('webhook.received', received('unknown_payment'))).toBe(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('rejected — parse failed, event unknown → "other"', async () => {
    gatewayReturns(new GatewayInvalidSignatureError('razorpay'));

    expect(await delta('webhook.received', received('rejected', 'other'), process)).toBe(1);
  });

  it('collapses an unlisted gateway event name to "other"', async () => {
    gatewayReturns({ ...EVENT, event: 'order.paid' });

    expect(await delta('webhook.received', received('updated', 'other'), process)).toBe(1);
  });
});

describe('webhook.relay.attempts outcome', () => {
  it.each([
    ['success', (): Promise<unknown> => Promise.resolve({ status: 200 })],
    [
      'http_error',
      (): Promise<unknown> => Promise.reject({ isAxiosError: true, response: { status: 503 } }),
    ],
    [
      'timeout',
      (): Promise<unknown> => Promise.reject({ isAxiosError: true, code: 'ECONNABORTED' }),
    ],
    [
      'network_error',
      (): Promise<unknown> => Promise.reject({ isAxiosError: true, code: 'ECONNREFUSED' }),
    ],
    ['network_error', (): Promise<unknown> => Promise.reject(new Error('boom'))],
  ])('%s', async (outcome, respond) => {
    vi.mocked(axios.post).mockImplementation(respond as never);

    expect(await delta('webhook.relay.attempts', { outcome }, process)).toBe(1);
  });
});
