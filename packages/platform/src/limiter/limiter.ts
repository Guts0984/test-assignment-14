import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { FIXED_WINDOW_LUA, SLIDING_WINDOW_LUA, SLOT_LUA } from './scripts.js';

export interface LimitDecision {
  readonly allowed: boolean;
  /** Requests counted in the current window, including this one when allowed. */
  readonly count: number;
  readonly retryAfterMs: number;
  /** True when Redis failed or timed out and the configured failure policy decided instead. */
  readonly degraded: boolean;
}

export type FailurePolicy = 'open' | 'closed';

export interface LimiterOptions {
  readonly onError: FailurePolicy;
  /** Upper bound for one Redis round trip. The caller never waits longer than this. */
  readonly timeoutMs: number;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('limiter timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

const parse = (raw: unknown): { allowed: boolean; count: number; retryAfterMs: number } => {
  if (!Array.isArray(raw) || raw.length < 3) throw new Error('unexpected limiter reply');
  return { allowed: Number(raw[0]) === 1, count: Number(raw[1]), retryAfterMs: Math.max(0, Number(raw[2])) };
};

/** Atomic limiters on Redis. State is disposable: losing Redis only resets the counters. */
export const createLimiter = (redis: Redis, options: LimiterOptions) => {
  const degraded = (): LimitDecision => ({
    allowed: options.onError === 'open',
    count: 0,
    retryAfterMs: options.onError === 'open' ? 0 : 1_000,
    degraded: true,
  });

  const run = async (script: string, key: string, args: readonly (string | number)[]): Promise<LimitDecision> => {
    try {
      const raw: unknown = await withTimeout(redis.eval(script, 1, key, ...args), options.timeoutMs);
      return { ...parse(raw), degraded: false };
    } catch {
      return degraded();
    }
  };

  /** Result of `reserveSlot`: how long to wait before sending, or `degraded` when Redis could not be asked. */
  const reserve = async (key: string, ratePerSecond: number): Promise<{ readonly waitMs: number; readonly degraded: boolean }> => {
    try {
      const raw: unknown = await withTimeout(redis.eval(SLOT_LUA, 1, key, Math.ceil(1_000 / ratePerSecond)), options.timeoutMs);
      if (!Array.isArray(raw)) throw new Error('unexpected limiter reply');
      return { waitMs: Math.max(0, Number(raw[0])), degraded: false };
    } catch {
      return { waitMs: 0, degraded: true };
    }
  };

  return Object.freeze({
    /** Evenly spaced send slots shared by all callers: `waitMs` is how long this caller must wait before sending. */
    reserveSlot: reserve,
    /** At most `limit` hits in ANY window of `windowMs` (exact). */
    slidingWindow: (key: string, limit: number, windowMs: number): Promise<LimitDecision> =>
      run(SLIDING_WINDOW_LUA, key, [limit, windowMs, randomUUID()]),
    /** At most `limit` hits per fixed window; the key always expires. */
    fixedWindow: (key: string, limit: number, windowMs: number): Promise<LimitDecision> =>
      run(FIXED_WINDOW_LUA, key, [limit, windowMs]),
  });
};

export type Limiter = ReturnType<typeof createLimiter>;
