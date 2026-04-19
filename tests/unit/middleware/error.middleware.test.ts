// tests/unit/middleware/error.middleware.test.ts
// Tests for the central error handler.
//
// Business invariants protected:
//   - AppError subclasses always produce correct HTTP status + error code
//   - Unknown errors always produce 500 with INTERNAL_ERROR code
//   - Client never receives internal error details for system failures
//   - isOperational flag correctly distinguishes client vs system errors
//   - Response shape always matches ApiErrorResponse

import { describe, it, expect, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../../../src/middleware/error.middleware';
import {
  PaymentNotFoundError,
  InvalidAmountError,
  GatewayTimeoutError,
  GatewayMappingError,
  StoreError,
  RefundNotAllowedError,
} from '../../../src/errors';
import { ErrorCode } from '../../../src/types/common.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(): Response {
  const res = {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function makeRequest(path = '/payments'): Request {
  return { method: 'GET', path } as Request;
}

const mockNext = vi.fn() as unknown as NextFunction;

// ---------------------------------------------------------------------------
// AppError subclasses — known operational errors
// ---------------------------------------------------------------------------

describe('errorHandler — AppError subclasses', () => {
  it('maps PaymentNotFoundError to 404 with PAYMENT_NOT_FOUND code', () => {
    const err = new PaymentNotFoundError('chk_abc123');
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: ErrorCode.PAYMENT_NOT_FOUND,
        }),
      }),
    );
  });

  it('maps InvalidAmountError to 400 with INVALID_AMOUNT code', () => {
    const err = new InvalidAmountError(-100);
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: ErrorCode.INVALID_AMOUNT,
        }),
      }),
    );
  });

  it('maps GatewayTimeoutError to 504 with GATEWAY_TIMEOUT code', () => {
    const err = new GatewayTimeoutError('razorpay', 'createPayment');
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: ErrorCode.GATEWAY_TIMEOUT,
        }),
      }),
    );
  });

  it('maps StoreError to 500 with STORE_ERROR code', () => {
    const err = new StoreError('savePayment', new Error('Redis down'));
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: ErrorCode.STORE_ERROR,
        }),
      }),
    );
  });

  it('maps RefundNotAllowedError to 422 with REFUND_NOT_ALLOWED code', () => {
    const err = new RefundNotAllowedError('chk_abc123', 'PENDING');
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: ErrorCode.REFUND_NOT_ALLOWED,
        }),
      }),
    );
  });

  it('includes the error message in the response', () => {
    const err = new PaymentNotFoundError('chk_xyz');
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonCall.error.message).toBe('Payment not found: chk_xyz');
  });

  it('includes details when present on AppError', () => {
    const err = new PaymentNotFoundError('chk_detail_test');
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonCall.error.details).toEqual({ chkId: 'chk_detail_test' });
  });
});

// ---------------------------------------------------------------------------
// Unknown errors — system failures
// ---------------------------------------------------------------------------

describe('errorHandler — unknown errors', () => {
  it('maps a plain Error to 500 with INTERNAL_ERROR code', () => {
    const err = new Error('Something broke internally');
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: ErrorCode.INTERNAL_ERROR,
        }),
      }),
    );
  });

  it('does NOT expose internal error message to client for unknown errors', () => {
    const err = new Error('Database credentials exposed in error');
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Client should never see the internal error message
    expect(jsonCall.error.message).not.toContain('credentials');
    expect(jsonCall.error.message).toBe('An unexpected error occurred. Please try again later.');
  });

  it('maps a thrown string to 500', () => {
    const err = 'string error';
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('maps a thrown object to 500', () => {
    const err = { code: 'SOME_LIB_ERROR', message: 'library failure' };
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ---------------------------------------------------------------------------
// Headers already sent
// ---------------------------------------------------------------------------

describe('errorHandler — headers already sent', () => {
  it('does not call res.json if headers are already sent', () => {
    const err = new PaymentNotFoundError('chk_abc');
    const res = makeResponse();
    (res as unknown as Record<string, unknown>)['headersSent'] = true;

    errorHandler(err, makeRequest(), res, mockNext);

    // Must not attempt to write a second response
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Response shape — always ApiErrorResponse
// ---------------------------------------------------------------------------

describe('errorHandler — response shape', () => {
  it('always returns success: false', () => {
    const errors = [
      new PaymentNotFoundError('chk_1'),
      new GatewayTimeoutError('razorpay', 'op'),
      new Error('unknown'),
    ];

    for (const err of errors) {
      const res = makeResponse();
      errorHandler(err, makeRequest(), res, mockNext);
      const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(jsonCall.success).toBe(false);
    }
  });

  it('error object always has code and message fields', () => {
    const err = new InvalidAmountError(0);
    const res = makeResponse();

    errorHandler(err, makeRequest(), res, mockNext);

    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonCall.error).toHaveProperty('code');
    expect(jsonCall.error).toHaveProperty('message');
  });
});
