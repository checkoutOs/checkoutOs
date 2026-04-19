// redis.client.ts
// Rules:
/*
Services and controllers never import from the file directly
Connection error are logged and re-thrown as StoreError
*/

import Redis from 'ioredis';
import { config } from '../config';
import { StoreError } from '../errors/store.errors';
import { createContextLogger } from '../utils/logger';

const log = createContextLogger('redis');

//lazyConnect true does not auto connect on instantiation
//  explicity connect in connectRedis() during server startup
//  startup validatoin can catch connection failures before acception traffic.

export const redisClient = new Redis(config.redis.url, {
  lazyConnect: true,

  // return null to stop retrying after 3 attempts in production
  // In development retry indefinitely so local redis restarts are handled

  maxRetriesPerRequest: 3,
  retryStrategy(times: number): number | null {
    if (!config.isDevelopment && times > 3) {
      // Stop retrying let the StoreError propagate
      return null;
    }
    // Exponential backoff: 200ms, 400ms, 800ms, capped at 2000ms
    return Math.min(times * 200, 2000);
  },
  enableOfflineQueue: false,
});

// Event listeners

redisClient.on('connect', (): void => {
  log.info('Connected');
});

redisClient.on('ready', (): void => {
  log.info('Ready to accept commands');
});

redisClient.on('error', (err: Error): void => {
  log.error('Connection error', { message: err.message });
});

redisClient.on('close', (): void => {
  log.warn('Connection closed');
});

redisClient.on('reconnecting', (): void => {
  log.warn('Reconnecting to Redis...');
});

/*

    Lifecycle helper
 */

export async function connectRedis(): Promise<void> {
  try {
    await redisClient.connect();
  } catch (err) {
    throw new StoreError('connect', err);
  }
}

export async function disconnectRedis(): Promise<void> {
  try {
    await redisClient.quit();
    log.info('Disconnected gracefully');
  } catch (err: unknown) {
    redisClient.disconnect();
    log.warn('Redis quit failed, forcing disconnect', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function pingRedis(): Promise<number> {
  const start = Date.now();
  try {
    await redisClient.ping();
    const latencyMs = Date.now() - start;
    log.debug('Ping successful', { latencyMs });
    return latencyMs;
  } catch (err) {
    throw new StoreError('ping', err);
  }
}
