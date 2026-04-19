// health.controller.ts
// Handles GET /health
//
// checkHealth() never throws by design — it always returns a HealthResponse.
// HTTP status reflects the health state:\
//   200 → status: 'ok'
//   503 → status: 'degraded' or 'error'

import { Request, Response } from 'express';
import { checkHealth } from '../services/health.service';
import { success } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

// GET /health
export const check = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const health = await checkHealth();

  // 503 for degraded or error — 200 only for fully healthy
  const httpStatus = health.status === 'ok' ? 200 : 503;

  res.status(httpStatus).json(success(health));
});
