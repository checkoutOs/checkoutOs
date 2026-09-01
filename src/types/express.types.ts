import 'express';

declare module 'express' {
  interface Request {
    idempotency?: {
      key: string;
      requestHash: string;
    };
  }
}

export {};
