import 'express';

declare module 'express' {
  interface Request {
    idempotencyKey?: {
      idempotencyKey: string;
      requestHash: string;
    };
  }
}

export {};
