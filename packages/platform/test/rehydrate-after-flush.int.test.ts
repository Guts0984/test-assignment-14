import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, createTestRedis, setClockOffset, waitFor, type TestDb, type TestRedis } from '@ticketing/testkit';
import { createRedis, createTaskQueue, createTaskRunner, createTaskWorker, getTask, rehydrate, scheduleTask, type TaskHandler, type TaskQueue } from '../src/index.js';

// Redis database 15 is private to this file: FLUSHDB there is "Redis lost everything" for this test only.
let tdb: TestDb;
let tr: TestRedis;
let queue: TaskQueue;
const closers: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  tdb = await createTestDb();
  tr = createTestRedis(15);
  queue = createTaskQueue({ connection: createRedis(tr.url, { db: 15 }), prefix: tr.prefix });
  closers.push(() => queue.close());
  startWorker('w1', handlers);
  startWorker('w2', handlers);
});
afterEach(async () => {
  await setClockOffset(tdb.pool, 0);
});
afterAll(async () => {
  for (const close of closers) await close();
  await tr.close();
  await tdb.drop();
});

const executions = new Map<string, number>();
const countingHandler: TaskHandler = async (task) => {
  executions.set(task.dedupeKey, (executions.get(task.dedupeKey) ?? 0) + 1);
};

let flakyCalls = 0;
const handlers: Record<string, TaskHandler> = {
  work: countingHandler,
  flaky: async () => {
    flakyCalls += 1;
    if (flakyCalls < 3) throw new Error('provider unavailable');
  },
  bad: async () => Promise.reject(new Error('boom')),
};

const startWorker = (owner: string, handlers: Record<string, TaskHandler>, concurrency = 5) => {
  const connection = createRedis(tr.url, { db: 15 });
  const runner = createTaskRunner({
    pool: tdb.pool,
    handlers,
    owner,
    leaseMs: 1_000,
    retryDelay: () => 50,
    wake: (key, runAt, delay) => queue.enqueue(key, runAt, delay),
  });
  const w = createTaskWorker({ connection, prefix: tr.prefix, runner, concurrency, lockDurationMs: 2_000, stalledIntervalMs: 500 });
  closers.push(() => w.close(), async () => void connection.disconnect());
  return w;
};

const rehydrateNow = (horizonMs = 60_000) =>
  rehydrate({ pool: tdb.pool, enqueue: (k, at, d) => queue.enqueue(k, at, d), horizonMs });

const allDone = async (prefix: string, expected: number): Promise<boolean> => {
  const r = await tdb.pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'done')::int AS done FROM tasks WHERE dedupe_key LIKE $1`, [`${prefix}%`]);
  return (r.rows[0] as { done: number }).done === expected;
};

describe('Redis loss does not lose or duplicate tasks', () => {
  it('tasks that only exist in Postgres are executed exactly once by two workers after FLUSH', async () => {
    for (let i = 0; i < 100; i += 1) await scheduleTask(tdb.pool, { kind: 'work', dedupeKey: `flush-a:${i}` });
    await tr.redis.flushdb(); // Redis forgets everything (nothing was ever enqueued)
    expect(await rehydrateNow()).toBeGreaterThanOrEqual(100);
    await waitFor(() => allDone('flush-a:', 100));
    for (let i = 0; i < 100; i += 1) expect(executions.get(`flush-a:${i}`), `task ${i}`).toBe(1);
  });

  it('tasks enqueued and then wiped from Redis are recovered, still exactly once', async () => {
    for (let i = 0; i < 30; i += 1) {
      await scheduleTask(tdb.pool, { kind: 'work', dedupeKey: `flush-b:${i}`, delayMs: 800 });
      await queue.enqueue(`flush-b:${i}`, new Date(Date.now() + 800), 800);
    }
    await tr.redis.flushdb();
    await rehydrateNow();
    await rehydrateNow(); // running it twice (two workers) is harmless
    await waitFor(() => allDone('flush-b:', 30));
    for (let i = 0; i < 30; i += 1) expect(executions.get(`flush-b:${i}`)).toBe(1);
  });

  it('a task due in 10 minutes runs promptly when the clock passes it, even though its BullMQ delay is still long', async () => {
    await scheduleTask(tdb.pool, { kind: 'work', dedupeKey: 'clock:1', delayMs: 10 * 60_000 });
    await rehydrateNow(15 * 60_000); // queued as a delayed job (~10 min)
    expect(executions.get('clock:1')).toBeUndefined();
    await setClockOffset(tdb.pool, 11 * 60_000);
    await rehydrateNow();
    await waitFor(() => allDone('clock:', 1));
    expect(executions.get('clock:1')).toBe(1);
  });

  it('a task abandoned by a dead worker (lease expired) is taken over once', async () => {
    await scheduleTask(tdb.pool, { kind: 'work', dedupeKey: 'dead:1' });
    const { claimTask } = await import('../src/index.js');
    expect(await claimTask(tdb.pool, 'dead:1', 'killed-worker', 300)).not.toBeNull(); // claimed, then the process "died"
    await tr.redis.flushdb();
    await waitFor(async () => {
      await rehydrateNow();
      return allDone('dead:', 1);
    });
    expect(executions.get('dead:1')).toBe(1);
    expect((await getTask(tdb.pool, 'dead:1'))?.attempts).toBe(2);
  });

  it('a failing handler is retried with backoff until it succeeds, then runs no more', async () => {
    await scheduleTask(tdb.pool, { kind: 'flaky', dedupeKey: 'retry:1' });
    await waitFor(async () => {
      await rehydrateNow();
      return allDone('retry:', 1);
    });
    expect(flakyCalls).toBe(3);
    await rehydrateNow();
    expect(flakyCalls).toBe(3);
  });

  it('a task that keeps failing ends as failed with its last error, not retried forever', async () => {
    await scheduleTask(tdb.pool, { kind: 'bad', dedupeKey: 'bad:1', maxAttempts: 3 });
    await waitFor(async () => {
      await rehydrateNow();
      return (await getTask(tdb.pool, 'bad:1'))?.status === 'failed';
    });
    expect(await getTask(tdb.pool, 'bad:1')).toMatchObject({ status: 'failed', attempts: 3, lastError: 'boom' });
  });

  it('an unknown task kind fails loudly instead of being silently dropped', async () => {
    await scheduleTask(tdb.pool, { kind: 'nobody-handles-this', dedupeKey: 'unknown:1' });
    await rehydrateNow();
    await waitFor(async () => (await getTask(tdb.pool, 'unknown:1'))?.status === 'failed');
    expect((await getTask(tdb.pool, 'unknown:1'))?.lastError).toContain('no handler');
  });
});
