// redact.ts
// Safe projection of a WebhookEvent — for anything that leaves the webhook
// service: log records, span attributes, and (if adopted) the merchant relay.
//
// Pure: no I/O, no logger, no side effects (ADR 003 §8.1 — a pure redaction
// function is a legitimate util; the EMISSION is what stays out of utils).
//
// Dropped:
//   raw               the entire gateway payload — customer and card-adjacent
//                     data; logging it pulls the log store into PCI scope
//   gatewayPaymentId  gateway internals; the chk_ ID identifies the payment
//   gatewayOrderId    same
//
// Allow-list, not deny-list: WEBHOOK_EVENT_FIELDS must decide every key of
// WebhookEvent, so adding a field to WebhookEvent is a compile error here
// until someone chooses whether it is safe — a new field can never leak by
// default.

import type { WebhookEvent } from '../types/gateway.types';

export const WEBHOOK_EVENT_FIELDS = {
  gateway: 'keep',
  event: 'keep',
  status: 'keep',
  amount: 'keep',
  currency: 'keep',
  raw: 'drop',
  gatewayPaymentId: 'drop',
  gatewayOrderId: 'drop',
} as const satisfies Record<keyof WebhookEvent, 'keep' | 'drop'>;

type KeptField = {
  [K in keyof typeof WEBHOOK_EVENT_FIELDS]: (typeof WEBHOOK_EVENT_FIELDS)[K] extends 'keep'
    ? K
    : never;
}[keyof typeof WEBHOOK_EVENT_FIELDS];

export type RedactedWebhookEvent = Pick<WebhookEvent, KeptField>;

export function redactWebhookEvent(event: WebhookEvent): RedactedWebhookEvent {
  return {
    gateway: event.gateway,
    event: event.event,
    status: event.status,
    amount: event.amount,
    currency: event.currency,
  };
}
