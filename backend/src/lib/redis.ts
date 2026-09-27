import IORedis, { type Redis } from 'ioredis';
import { config } from '../config';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by workers
 * (blocking commands must not time out). We use the same settings everywhere.
 */
export function createRedis(): Redis {
  return new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

/** Shared connection for non-blocking commands (rate limiter, notification dedupe). */
export const redis = createRedis();
