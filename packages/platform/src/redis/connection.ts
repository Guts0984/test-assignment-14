import { Redis } from 'ioredis';

export type { Redis } from 'ioredis';

/**
 * Connection for BullMQ and the limiters. `maxRetriesPerRequest: null` is required by BullMQ workers;
 * callers that must not hang (limiters) enforce their own timeouts.
 */
export const createRedis = (url: string, options: { readonly db?: number; readonly connectionName?: string; readonly lazyConnect?: boolean; readonly onError?: (error: Error) => void } = {}): Redis => {
  const redis = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    db: options.db ?? 0,
    connectionName: options.connectionName,
    lazyConnect: options.lazyConnect ?? false,
  });
  // Connection problems surface as failed commands (handled by callers' policies); never as unhandled events.
  redis.on('error', (error: Error) => options.onError?.(error));
  return redis;
};
