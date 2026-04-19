// id.ts
/*
    Rules (from spec):
    chk_{uuid_v4_without_dashes} -> payment IDs
    ref_{uid_v4_without_dashes} -> refund IDs

*/

import { v4 as uuidv4 } from 'uuid';

export const PAYMENT_ID_PREFIX = 'chk_' as const;
export const REFUND_ID_PREFIX = 'ref_' as const;

function generateId(prefix: string): string {
  const raw = uuidv4().replace(/-/g, '');
  return `${prefix}${raw}`;
}

export function generatePaymentId(): string {
  return generateId(PAYMENT_ID_PREFIX);
}

export function generateRefundId(): string {
  return generateId(REFUND_ID_PREFIX);
}

export function isValidPaymentId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.startsWith(PAYMENT_ID_PREFIX) &&
    id.length === PAYMENT_ID_PREFIX.length + 32
  );
}

export function isValidRefundId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.startsWith(REFUND_ID_PREFIX) &&
    id.length === REFUND_ID_PREFIX.length + 32
  );
}
