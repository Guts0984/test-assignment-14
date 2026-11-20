import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestRedis, waitFor } from '@ticketing/testkit';
import { createLimiter } from '../src/index.js';

const tr = createTestRedis();
const limiter = createLimiter(tr.redis, { onError: 'closed', timeoutMs: 1_000 });
afterAll(async () => {
  await tr.close();
});

const key = (name: string): string => `${tr.prefix}:${name}`;

describe('sliding window limiter', () => {
  it('lets exactly `limit` of 200 concurrent requests through', async () => {
    const results = await Promise.all(Array.from({ length: 200 }, () => limiter.slidingWindow(key('flood'), 20, 3_000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    expect(results.every((r) => !r.degraded)).toBe(true);
  });

  it('is exact at the boundary: request 20 passes, 21 is refused with a Retry-After inside the window', async () => {
    const k = key('boundary');
    for (let i = 1; i <= 20; i += 1) expect((await limiter.slidingWindow(k, 20, 5_000)).allowed, `request ${i}`).toBe(true);
    const refused = await limiter.slidingWindow(k, 20, 5_000);
    expect(refused.allowed).toBe(false);
    expect(refused.count).toBe(20);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it('never allows more than the limit in ANY window, including across a boundary burst', async () => {
    const k = key('burst');
    const allowedAt: number[] = [];
    const hit = async (): Promise<void> => {
      if ((await limiter.slidingWindow(k, 5, 400)).allowed) allowedAt.push(Date.now());
    };
    await Promise.all(Array.from({ length: 5 }, hit));
    await waitFor(async () => (await limiter.slidingWindow(`${k}:probe`, 1, 1)).allowed && Date.now() - (allowedAt[0] ?? 0) > 350);
    await Promise.all(Array.from({ length: 10 }, hit));
    await waitFor(async () => (await limiter.slidingWindow(`${k}:probe2`, 1, 1)).allowed && Date.now() - (allowedAt[0] ?? 0) > 800);
    await Promise.all(Array.from({ length: 10 }, hit));
    const sorted = [...allowedAt].sort((a, b) => a - b);
    for (let i = 0; i + 5 < sorted.length; i += 1) {
      expect((sorted[i + 5] ?? 0) - (sorted[i] ?? 0), 'six allowed hits inside one 400 ms window').toBeGreaterThan(395);
    }
  });

  it('recovers after the window passes', async () => {
    const k = key('recover');
    for (let i = 0; i < 3; i += 1) await limiter.slidingWindow(k, 3, 300);
    expect((await limiter.slidingWindow(k, 3, 300)).allowed).toBe(false);
    await waitFor(async () => (await limiter.slidingWindow(k, 3, 300)).allowed, 3_000);
  });

  it('one noisy key never affects another (an attacker cannot lock out other IPs)', async () => {
    const attacker = key('ip:203.0.113.9');
    const victim = key('ip:198.51.100.7');
    const flood = Promise.all(Array.from({ length: 500 }, () => limiter.slidingWindow(attacker, 20, 2_000)));
    const started = Date.now();
    const victimResults = await Promise.all(Array.from({ length: 10 }, () => limiter.slidingWindow(victim, 20, 2_000)));
    await flood;
    expect(victimResults.every((r) => r.allowed)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('keys always expire (no unbounded growth)', async () => {
    const keys = Array.from({ length: 300 }, (_, i) => key(`ttl:${i}`));
    await Promise.all(keys.map((k) => limiter.slidingWindow(k, 5, 60_000)));
    const ttls = await Promise.all(keys.map((k) => tr.redis.pttl(k)));
    expect(ttls.every((t) => t > 0 && t <= 60_000)).toBe(true);
  });
});

describe('fixed window limiter', () => {
  it('allows exactly `limit` of 100 concurrent requests', async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.fixedWindow(key('fixed'), 10, 5_000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('always sets a TTL, even if the key was created without one, and recovers', async () => {
    const k = key('fixed-ttl');
    await tr.redis.set(k, '99'); // a key that lost its TTL (e.g. a bug elsewhere)
    const first = await limiter.fixedWindow(k, 5, 300);
    expect(first.allowed).toBe(false);
    expect(await tr.redis.pttl(k)).toBeGreaterThan(0);
    await waitFor(async () => (await limiter.fixedWindow(k, 5, 300)).allowed, 3_000);
  });
});

describe('Redis unavailable', () => {
  const deadClient = (): Redis => {
    const client = new Redis('redis://127.0.0.1:6399', { maxRetriesPerRequest: null, retryStrategy: () => 1_000 });
    client.on('error', () => undefined);
    return client;
  };

  it('fail-open lets requests through, flagged degraded, without hanging', async () => {
    const dead = deadClient();
    const open = createLimiter(dead, { onError: 'open', timeoutMs: 150 });
    const started = Date.now();
    const decision = await open.fixedWindow('k', 1, 1_000);
    expect(decision).toMatchObject({ allowed: true, degraded: true });
    expect(Date.now() - started).toBeLessThan(600);
    dead.disconnect();
  });

  it('fail-closed refuses and tells the client when to come back', async () => {
    const dead = deadClient();
    const closed = createLimiter(dead, { onError: 'closed', timeoutMs: 150 });
    const decision = await closed.slidingWindow('k', 20, 1_000);
    expect(decision).toMatchObject({ allowed: false, degraded: true });
    expect(decision.retryAfterMs).toBeGreaterThan(0);
    dead.disconnect();
  });
});

describe('slot scheduler', () => {
  it('hands concurrent callers distinct, evenly spaced slots, so calls cannot arrive in a burst', async () => {
    const waits = (await Promise.all(Array.from({ length: 30 }, () => limiter.reserveSlot(key('slots'), 10)))).map((r) => r.waitMs).sort((a, b) => a - b);
    expect(new Set(waits).size).toBe(30);
    for (let i = 1; i < waits.length; i += 1) expect((waits[i] ?? 0) - (waits[i - 1] ?? 0)).toBeGreaterThanOrEqual(80); // 10 per second = one slot per 100 ms (each wait is measured at a slightly different moment, hence the tolerance)
    expect(waits[29]).toBeGreaterThanOrEqual(2_600);
  });

  it('flags a Redis outage instead of hanging', async () => {
    const dead = new Redis('redis://127.0.0.1:6399', { maxRetriesPerRequest: null, retryStrategy: () => 1_000 });
    dead.on('error', () => undefined);
    const r = await createLimiter(dead, { onError: 'closed', timeoutMs: 150 }).reserveSlot('k', 10);
    expect(r.degraded).toBe(true);
    dead.disconnect();
  });
});
