import { ApiSuccessResponse, ErrorCodeValue, ApiErrorResponse } from '../types/common.types';

export function success<T>(data: T, meta?: Record<string, unknown>): ApiSuccessResponse<T> {
  return {
    success: true,
    data,
    ...(meta ? { meta } : {}),
  };
}

export function error(
  code: ErrorCodeValue,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorResponse {
  const hasValidDetails = details && Object.values(details).some((v): boolean => v !== undefined);

  return {
    success: false,
    error: {
      code,
      message,
      ...(hasValidDetails ? { details } : {}),
    },
  };
}

// Optional: re-export types for convenience
export type { ApiSuccessResponse, ApiErrorResponse };
