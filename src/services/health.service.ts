// health.service.ts
/*
Called by HealthController -> GET / health

Never throws always return HealthResponse
Redis and gateway checks run parallel Promise.allSettled


A degraded dependency returns status 'degraded' not 500

*/

import { pingRedis } from '../store/redis.client';
import { getActiveGateway } from '../gateways/gateway.registry';
import { createContextLogger } from '../utils/logger';
import { now } from '../utils/time';
import type { HealthResponse, ServiceHealth } from '../types/common.types';

const log = createContextLogger('health-service');

export async function checkHealth(): Promise<HealthResponse> {
  // Run both checks cuncurrently
  const [redisResult, gatewayResult] = await Promise.allSettled([checkRedis(), checkGateway()]);

  const redis: ServiceHealth =
    redisResult.status === 'fulfilled'
      ? redisResult.value
      : { healthy: false, error: String(redisResult.reason) };

  const gateway: ServiceHealth =
    gatewayResult.status === 'fulfilled'
      ? gatewayResult.value
      : { healthy: false, error: String(gatewayResult.reason) };

  const allHealthy = redis.healthy && gateway.healthy;
  log.debug('Sumit debug', { gatewayResult });
  const status: HealthResponse['status'] = allHealthy
    ? 'ok'
    : redis.healthy || gateway.healthy
      ? 'degraded'
      : 'error';

  if (!allHealthy) {
    log.warn('Health check degraded', { redis, gateway });
  }

  return {
    status,
    timestamp: now(),
    services: { redis, gateway },
  };
}

async function checkGateway(): Promise<ServiceHealth> {
  try {
    const plugin = getActiveGateway();
    const result = await plugin.healthCheck();

    return { healthy: result.healthy, latencyMs: result.latencyMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Gateay health check failed', { error: message });
    return { healthy: false, error: message };
  }
}

async function checkRedis(): Promise<ServiceHealth> {
  try {
    const latencyMs = await pingRedis();
    return { healthy: true, latencyMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Redis health check failed', { error: message });
    return { healthy: false, error: message };
  }
}
