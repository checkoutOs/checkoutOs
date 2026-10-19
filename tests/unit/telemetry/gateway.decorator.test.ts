// tests/unit/telemetry/gateway.decorator.test.ts
// Unit tests for withTelemetry() — gateway metrics applied at the registry
// (ADR 003 §6.1).
//
// Business invariants protected:
//   - `this` survives wrapping: both plugins are classes using this.creds /
//     this.http, and an unbound method throws on the first real call
//   - the five async methods record gateway.request.duration +
//     gateway.requests with the right outcome, and rethrow the SAME error
//   - outcomes are classified by error code: timeout, mapping_error,
//     gateway_error (anything else, including non-AppErrors)
//   - parseWebhookEvent stays SYNCHRONOUS and counts signature failures for
//     BOTH gateways — by code, so a gateway throwing its own class/code
//     (PAYTM_CHECKSUM_FAILED) is still counted; other parse errors are not
//   - getCheckoutAction is passed through, sync or async
//
// Metrics are read through tests/helpers/metrics.helper.ts (the SDK never
// starts under vitest).

import { describe, it, expect } from 'vitest';
import { withTelemetry, SIGNATURE_FAILURE_CODES } from '../../../src/telemetry/gateway.decorator';
import { createRazorpayPlugin } from '../../../src/gateways/razorpay/razorpay.plugin';
import { createPaytmPlugin } from '../../../src/gateways/paytm/paytm.plugin';
import {
  GatewayInvalidSignatureError,
  GatewayMappingError,
  GatewayTimeoutError,
  GatewayUnavailableError,
} from '../../../src/errors/gateways.errors';
import { PaytmChecksumFailedError } from '../../../src/errors/paytm.errors';
import { ErrorCode } from '../../../src/types/common.types';
import { PaymentStatus, RefundStatus } from '../../../src/types/payment.types';
import type {
  CheckoutAction,
  GatewayPlugin,
  GatewayPaymentResult,
  GatewayRefundResult,
  WebhookEvent,
} from '../../../src/types/gateway.types';
import type { StoredPayment } from '../../../src/types/payment.types';
import { installTestMeterProvider } from '../../helpers/metrics.helper';

const { total, delta } = installTestMeterProvider();

// ---------------------------------------------------------------------------
// A class-based fake plugin: every method reads `this`, like the real ones.
// ---------------------------------------------------------------------------

const PAYMENT_RESULT: GatewayPaymentResult = {
  gatewayId: 'order_1',
  status: PaymentStatus.PENDING,
  amount: 50000,
  currency: 'INR',
} as GatewayPaymentResult;

const REFUND_RESULT: GatewayRefundResult = {
  gatewayRefundId: 'rfnd_1',
  status: RefundStatus.PENDING,
  amount: 50000,
} as GatewayRefundResult;

const WEBHOOK_EVENT: WebhookEvent = {
  gateway: 'razorpay',
  gatewayPaymentId: 'pay_1',
  event: 'payment.captured',
  status: PaymentStatus.SUCCESS,
  amount: 50000,
  currency: 'INR',
  raw: {},
};

class FakePlugin implements GatewayPlugin {
  readonly name = 'razorpay';
  private readonly secret = 'needs-this';
  failWith: unknown = undefined;

  private check(): void {
    if (this.secret !== 'needs-this') throw new TypeError('this was lost');
    if (this.failWith !== undefined) throw this.failWith;
  }

  async createPayment(): Promise<GatewayPaymentResult> {
    this.check();
    return PAYMENT_RESULT;
  }
  async getPaymentStatus(): Promise<GatewayPaymentResult> {
    this.check();
    return PAYMENT_RESULT;
  }
  async createRefund(): Promise<GatewayRefundResult> {
    this.check();
    return REFUND_RESULT;
  }
  async getRefundStatus(): Promise<GatewayRefundResult> {
    this.check();
    return REFUND_RESULT;
  }
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    this.check();
    return { healthy: true, latencyMs: 1 };
  }
  parseWebhookEvent(): WebhookEvent {
    this.check();
    return WEBHOOK_EVENT;
  }
  getCheckoutAction(): Promise<CheckoutAction> | CheckoutAction {
    this.check();
    return { type: 'redirect', url: 'https://example.test/pay' } as CheckoutAction;
  }
}

const STORED = {} as StoredPayment;

// ---------------------------------------------------------------------------

describe('withTelemetry — this binding', () => {
  it('keeps `this` for every wrapped method', async () => {
    const wrapped = withTelemetry(new FakePlugin());

    await expect(wrapped.createPayment({} as never)).resolves.toBe(PAYMENT_RESULT);
    await expect(wrapped.getPaymentStatus('order_1')).resolves.toBe(PAYMENT_RESULT);
    await expect(wrapped.createRefund({} as never)).resolves.toBe(REFUND_RESULT);
    await expect(wrapped.getRefundStatus('rfnd_1')).resolves.toBe(REFUND_RESULT);
    await expect(wrapped.healthCheck()).resolves.toEqual({ healthy: true, latencyMs: 1 });
    expect(wrapped.parseWebhookEvent({}, {})).toBe(WEBHOOK_EVENT);
    expect(wrapped.getCheckoutAction(STORED)).toEqual({
      type: 'redirect',
      url: 'https://example.test/pay',
    });
    expect(wrapped.name).toBe('razorpay');
  });

  it('keeps `this` on the real Razorpay plugin (HMAC reads this.creds)', () => {
    const wrapped = withTelemetry(
      createRazorpayPlugin({
        credentials: { keyId: 'rzp_test_x', keySecret: 'secret', webhookSecret: 'whsec' },
        baseUrl: 'http://127.0.0.1:9',
      }),
    );

    // An unbound method would fail with a TypeError reading this.creds before
    // ever reaching the signature check.
    expect(() =>
      wrapped.parseWebhookEvent('{}', { 'x-razorpay-signature': 'ab'.repeat(32) }),
    ).toThrow(GatewayInvalidSignatureError);
  });
});

describe('withTelemetry — async methods', () => {
  it('records duration and a success request with gateway/operation/outcome', async () => {
    const wrapped = withTelemetry(new FakePlugin());
    const labels = { gateway: 'razorpay', operation: 'createPayment', outcome: 'success' };

    expect(await delta('gateway.requests', labels, () => wrapped.createPayment({} as never))).toBe(
      1,
    );
    expect(
      await delta('gateway.request.duration', labels, () => wrapped.createPayment({} as never)),
    ).toBe(1);
  });

  it.each([
    ['timeout', () => new GatewayTimeoutError('razorpay', 'getPaymentStatus')],
    ['mapping_error', () => new GatewayMappingError('bad status', 'razorpay')],
    ['gateway_error', () => new GatewayUnavailableError('razorpay', 'HTTP 502')],
    ['gateway_error', () => new Error('socket hang up')],
    ['gateway_error', () => 'a thrown string'],
  ])('classifies a failure as %s and rethrows the same error', async (outcome, make) => {
    const plugin = new FakePlugin();
    const error = make();
    plugin.failWith = error;
    const wrapped = withTelemetry(plugin);
    const labels = { gateway: 'razorpay', operation: 'getPaymentStatus', outcome };

    const success = { operation: 'getPaymentStatus', outcome: 'success' };
    const successBefore = await total('gateway.requests', success);

    const moved = await delta('gateway.requests', labels, async () => {
      await expect(wrapped.getPaymentStatus('order_1')).rejects.toBe(error);
    });

    expect(moved).toBe(1);
    expect(await total('gateway.requests', success)).toBe(successBefore);
  });

  it('labels each of the five operations', async () => {
    const wrapped = withTelemetry(new FakePlugin());
    const calls: [string, () => Promise<unknown>][] = [
      ['createPayment', () => wrapped.createPayment({} as never)],
      ['getPaymentStatus', () => wrapped.getPaymentStatus('x')],
      ['createRefund', () => wrapped.createRefund({} as never)],
      ['getRefundStatus', () => wrapped.getRefundStatus('x')],
      ['healthCheck', () => wrapped.healthCheck()],
    ];

    for (const [operation, call] of calls) {
      expect(await delta('gateway.requests', { operation }, call), operation).toBe(1);
    }
  });
});

describe('withTelemetry — parseWebhookEvent', () => {
  it('stays synchronous', () => {
    const result = withTelemetry(new FakePlugin()).parseWebhookEvent({}, {});

    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toBe(WEBHOOK_EVENT);
  });

  it('records no gateway request metrics', async () => {
    const wrapped = withTelemetry(new FakePlugin());

    expect(await delta('gateway.requests', {}, () => wrapped.parseWebhookEvent({}, {}))).toBe(0);
  });

  it('counts a Razorpay signature failure', async () => {
    const wrapped = withTelemetry(
      createRazorpayPlugin({
        credentials: { keyId: 'rzp_test_x', keySecret: 'secret', webhookSecret: 'whsec' },
        baseUrl: 'http://127.0.0.1:9',
      }),
    );

    const moved = await delta('webhook.signature_failures', { gateway: 'razorpay' }, () => {
      expect(() =>
        wrapped.parseWebhookEvent('{"event":"payment.captured"}', {
          'x-razorpay-signature': 'ab'.repeat(32),
        }),
      ).toThrow(GatewayInvalidSignatureError);
    });

    expect(moved).toBe(1);
  });

  it('counts a Paytm checksum failure', async () => {
    const wrapped = withTelemetry(
      createPaytmPlugin({
        credentials: { merchantId: 'MID001', merchantKey: 'key', webhookSecret: '' },
        baseUrl: 'http://127.0.0.1:9',
      }),
    );

    const moved = await delta('webhook.signature_failures', { gateway: 'paytm' }, () => {
      // No CHECKSUMHASH at all — the plugin's first signature check.
      expect(() =>
        wrapped.parseWebhookEvent({ TXNID: 'T1', STATUS: 'TXN_SUCCESS', ORDERID: 'O1' }, {}),
      ).toThrow(GatewayInvalidSignatureError);
    });

    expect(moved).toBe(1);
  });

  it('counts by error CODE — a different class with PAYTM_CHECKSUM_FAILED is counted', async () => {
    const plugin = new FakePlugin();
    Object.defineProperty(plugin, 'name', { value: 'paytm' });
    plugin.failWith = new PaytmChecksumFailedError();
    const wrapped = withTelemetry(plugin);

    const moved = await delta('webhook.signature_failures', { gateway: 'paytm' }, () =>
      wrapped.parseWebhookEvent({}, {}),
    );

    expect(moved).toBe(1);
  });

  it('does not count other parse errors, and rethrows them', async () => {
    const plugin = new FakePlugin();
    const error = new GatewayMappingError('Missing TXNID', 'razorpay');
    plugin.failWith = error;
    const wrapped = withTelemetry(plugin);

    const moved = await delta('webhook.signature_failures', {}, () => {
      expect(() => wrapped.parseWebhookEvent({}, {})).toThrow(error);
    });

    expect(moved).toBe(0);
  });

  it('lists the signature codes both gateways can throw', () => {
    expect(SIGNATURE_FAILURE_CODES.has(ErrorCode.GATEWAY_INVALID_SIGNATURE)).toBe(true);
    expect(SIGNATURE_FAILURE_CODES.has(ErrorCode.PAYTM_CHECKSUM_FAILED)).toBe(true);
  });
});

describe('withTelemetry — getCheckoutAction', () => {
  it('passes a sync result through without making it a Promise', () => {
    const result = withTelemetry(new FakePlugin()).getCheckoutAction(STORED);

    expect(result).not.toBeInstanceOf(Promise);
  });

  it('passes an async result through unchanged', async () => {
    const plugin = new FakePlugin();
    const action = { type: 'render' } as CheckoutAction;
    plugin.getCheckoutAction = async (): Promise<CheckoutAction> => action;

    await expect(withTelemetry(plugin).getCheckoutAction(STORED)).resolves.toBe(action);
  });
});
