import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';

export const hostReachableRedisUrl = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.hostname === 'redis') parsed.hostname = 'localhost';
  return parsed.toString();
};

export interface TestRedis {
  readonly redis: Redis;
  readonly url: string;
  /** Unique key prefix so parallel test files never see each other's keys. */
  readonly prefix: string;
  readonly close: () => Promise<void>;
}

/**
 * A connection with a private key prefix. `db` selects a logical database; tests that wipe Redis
 * (FLUSHDB, the same effect as losing all data) use their own database index.
 */
export const createTestRedis = (db = 0): TestRedis => {
  const url = hostReachableRedisUrl(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  const redis = new Redis(url, { db, maxRetriesPerRequest: null });
  return { redis, url, prefix: `t${randomBytes(5).toString('hex')}`, close: async () => void (await redis.quit()) };
};
