// errors/index.ts
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
  OrderIdAmountMismatchError,
  orderIdCurrencyMismatchError,
} from './idempotency.errors';

export { StoreError } from './store.errors';
