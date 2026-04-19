// routes/index.ts
// Exports all routers.
// app.ts imports from here so it never needs to know internal route file names.

export { healthRouter } from './health.routes';
export { refundRouter } from './refunds.routes';
export { paymentRouter } from './payments.routes';
export { webhookRouter } from './webhooks.routes';
