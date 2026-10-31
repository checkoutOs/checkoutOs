// tests/unit/utils/redact.test.ts
// Unit tests for redactWebhookEvent (ADR 003 §8.1).
//
// Business invariants protected:
//   - the gateway payload (raw) and gateway IDs never survive redaction —
//     anything logged from a webhook stays out of PCI scope
//   - the fields needed to understand the event (gateway, event, status,
//     amount, currency) are kept unchanged
//   - the function is pure: the input event is not mutated

import { describe, it, expect } from 'vitest';
import { redactWebhookEvent, WEBHOOK_EVENT_FIELDS } from '../../../src/utils/redact';
import { PaymentStatus } from '../../../src/types/payment.types';
import type { WebhookEvent } from '../../../src/types/gateway.types';

function webhookEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    gateway: 'razorpay',
    gatewayPaymentId: 'pay_SECRET123',
    gatewayOrderId: 'order_SECRET456',
    event: 'payment.captured',
    status: PaymentStatus.SUCCESS,
    amount: 50000,
    currency: 'INR',
    raw: {
      payload: {
        payment: {
          entity: { id: 'pay_SECRET123', email: 'customer@example.com', card: { last4: '1111' } },
        },
      },
    },
    ...overrides,
  };
}

describe('redactWebhookEvent', () => {
  it('keeps exactly gateway, event, status, amount and currency', () => {
    expect(redactWebhookEvent(webhookEvent())).toEqual({
      gateway: 'razorpay',
      event: 'payment.captured',
      status: PaymentStatus.SUCCESS,
      amount: 50000,
      currency: 'INR',
    });
  });

  it('drops raw and every gateway ID, wherever they appear', () => {
    const serialised = JSON.stringify(redactWebhookEvent(webhookEvent()));

    expect(serialised).not.toContain('SECRET');
    expect(serialised).not.toContain('customer@example.com');
    expect(serialised).not.toContain('last4');
  });

  it('works when the optional gatewayOrderId is absent', () => {
    const { gatewayOrderId: _omitted, ...withoutOrderId } = webhookEvent();

    expect(redactWebhookEvent(withoutOrderId)).not.toHaveProperty('gatewayOrderId');
  });

  it('returns exactly the fields the allow-list keeps', () => {
    const kept = Object.entries(WEBHOOK_EVENT_FIELDS)
      .filter(([, decision]) => decision === 'keep')
      .map(([field]) => field);

    expect(Object.keys(redactWebhookEvent(webhookEvent())).sort()).toEqual(kept.sort());
  });

  it('does not mutate its input', () => {
    const event = webhookEvent();
    const before = structuredClone(event);

    redactWebhookEvent(event);

    expect(event).toEqual(before);
  });
});
