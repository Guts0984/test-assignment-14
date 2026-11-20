import type { Redis } from 'ioredis';
import type { QueueCacheHooks } from './virtual-queue.js';

/**
 * Redis sorted set per event: member = user id, score = queue sequence. It only accelerates position reads;
 * `rebuild` recreates it from Postgres in the same order, so a flushed Redis costs one query, not a place.
 */
export const createRedisQueueCache = (redis: Redis, prefix = 'vq'): QueueCacheHooks => {
  const key = (eventId: string): string => `${prefix}:${eventId}:waiting`;
  return {
    onJoined: async (eventId, userId, seq) => void (await redis.zadd(key(eventId), seq, userId)),
    onLeft: async (eventId, userIds) => {
      if (userIds.length > 0) await redis.zrem(key(eventId), ...userIds);
    },
    position: async (eventId, userId) => {
      const rank = await redis.zrank(key(eventId), userId);
      return rank === null ? null : rank + 1;
    },
    rebuild: async (eventId, waiting) => {
      const pipeline = redis.multi().del(key(eventId));
      for (let i = 0; i < waiting.length; i += 500) {
        const args = waiting.slice(i, i + 500).flatMap((w) => [w.seq, w.userId]);
        pipeline.zadd(key(eventId), ...args);
      }
      await pipeline.exec();
    },
  };
};
