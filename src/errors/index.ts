// errors/index.ts
// Barrel re-exports for all AppError subclasses.
// Ordered by domain: gateway → paytm → payment → idempotency → store.

export { AppError } from './app.errors';

export {
  GatewayTimeoutError,
  GatewayUnavailableError,
  GatewayInvalidSignatureError,
  GatewayMappingError,
  RefundNotReadyError,
} from './gateways.errors';

export {
  PaytmPhoneRequiredError,
  PaytmChecksumFailedError,
  PaytmWebhookParseError,
} from './paytm.errors';

export {
  PaymentNotFoundError,
  PaymentFailedError,
  PaymentCreationFailedError,
  InvalidAmountError,
  OrderIdAmountMismatchError,
  OrderIdCurrencyMismatchError,
  RefundNotAllowedError,
  RefundNotFoundError,
  RefundAmountExceedsPaymentError,
  RefundFailedError,
} from './payment.errors';

export {
  IdempotencyKeyReusedError,
  IdempotencyRequestInProgressError,
  IdempotencyKeyMissingError,
  IdempotencyKeyInvalidError,
} from './idempotency.errors';

export { StoreError } from './store.errors';
