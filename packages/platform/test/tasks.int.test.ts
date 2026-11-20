import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, setClockOffset, type TestDb } from '@ticketing/testkit';
import { claimTask, completeTask, failExhausted, failTask, getTask, listDueTasks, rescheduleTask, restartTask, scheduleTask } from '../src/index.js';

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb.drop();
});

describe('durable tasks', () => {
  it('scheduling is idempotent per dedupe key', async () => {
    const first = await scheduleTask(tdb.pool, { kind: 'expire_hold', dedupeKey: 'idem:1' });
    const second = await scheduleTask(tdb.pool, { kind: 'expire_hold', dedupeKey: 'idem:1', delayMs: 5_000 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect((await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM tasks WHERE dedupe_key = 'idem:1'`)).rows[0]).toMatchObject({ n: 1 });
  });

  it('50 concurrent claims: exactly one wins', async () => {
    await scheduleTask(tdb.pool, { kind: 'k', dedupeKey: 'race:1' });
    const claims = await Promise.all(Array.from({ length: 50 }, (_, i) => claimTask(tdb.pool, 'race:1', `worker-${i}`, 30_000)));
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    expect((await getTask(tdb.pool, 'race:1'))?.attempts).toBe(1);
  });

  it('is not claimable before it is due, and becomes claimable when the (mocked) clock passes run_at', async () => {
    await scheduleTask(tdb.pool, { kind: 'expire_hold', dedupeKey: 'later:1', delayMs: 10 * 60_000 });
    expect(await claimTask(tdb.pool, 'later:1', 'w', 1_000)).toBeNull();
    expect((await listDueTasks(tdb.pool, 30_000, 100)).map((t) => t.dedupeKey)).not.toContain('later:1');
    expect((await listDueTasks(tdb.pool, 11 * 60_000, 100)).map((t) => t.dedupeKey)).toContain('later:1');
    await setClockOffset(tdb.pool, 11 * 60_000);
    expect(await claimTask(tdb.pool, 'later:1', 'w', 1_000)).not.toBeNull();
    await setClockOffset(tdb.pool, 0);
  });

  it('a dead worker\'s lease can be taken over, and the old owner can no longer complete or fail the task', async () => {
    await scheduleTask(tdb.pool, { kind: 'k', dedupeKey: 'lease:1' });
    const first = await claimTask(tdb.pool, 'lease:1', 'dead-worker', 60_000);
    expect(first).not.toBeNull();
    expect(await claimTask(tdb.pool, 'lease:1', 'other', 60_000)).toBeNull(); // lease still alive
    await setClockOffset(tdb.pool, 61_000);
    const second = await claimTask(tdb.pool, 'lease:1', 'new-worker', 60_000);
    expect(second?.leaseOwner).toBe('new-worker');
    expect(second?.attempts).toBe(2);
    expect(await completeTask(tdb.pool, first?.id ?? '', 'dead-worker')).toBe(false);
    expect(await failTask(tdb.pool, first?.id ?? '', 'dead-worker', 'x', 0)).toBe('lost');
    expect(await completeTask(tdb.pool, second?.id ?? '', 'new-worker')).toBe(true);
    await setClockOffset(tdb.pool, 0);
  });

  it('failure schedules a retry after the delay; running out of attempts makes the task failed and visible', async () => {
    await scheduleTask(tdb.pool, { kind: 'k', dedupeKey: 'fail:1', maxAttempts: 2 });
    const a1 = await claimTask(tdb.pool, 'fail:1', 'w', 1_000);
    expect(await failTask(tdb.pool, a1?.id ?? '', 'w', 'provider 503', 60_000)).toBe('retry');
    expect((await getTask(tdb.pool, 'fail:1'))?.status).toBe('pending');
    expect(await claimTask(tdb.pool, 'fail:1', 'w', 1_000)).toBeNull(); // backoff not over
    await setClockOffset(tdb.pool, 61_000);
    const a2 = await claimTask(tdb.pool, 'fail:1', 'w', 1_000);
    expect(await failTask(tdb.pool, a2?.id ?? '', 'w', 'provider 503 again', 60_000)).toBe('failed');
    const failed = await getTask(tdb.pool, 'fail:1');
    expect(failed).toMatchObject({ status: 'failed', attempts: 2, lastError: 'provider 503 again' });
    expect(await claimTask(tdb.pool, 'fail:1', 'w', 1_000)).toBeNull(); // never retried automatically
    // finance restarts it: attempts reset, runs again exactly once
    expect(await restartTask(tdb.pool, failed?.id ?? '')).toBe(true);
    expect(await restartTask(tdb.pool, failed?.id ?? '')).toBe(false); // second restart is a no-op
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => claimTask(tdb.pool, 'fail:1', `w${i}`, 1_000)));
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    await setClockOffset(tdb.pool, 0);
  });

  it('a worker that dies on the last attempt leaves a failed task, not a zombie', async () => {
    await scheduleTask(tdb.pool, { kind: 'k', dedupeKey: 'zombie:1', maxAttempts: 1 });
    await claimTask(tdb.pool, 'zombie:1', 'dies', 1_000);
    await setClockOffset(tdb.pool, 5_000);
    expect(await claimTask(tdb.pool, 'zombie:1', 'other', 1_000)).toBeNull();
    expect(await failExhausted(tdb.pool)).toBeGreaterThanOrEqual(1);
    expect((await getTask(tdb.pool, 'zombie:1'))?.status).toBe('failed');
    await setClockOffset(tdb.pool, 0);
  });

  it('reschedule (batch progress) resets attempts and runs again later', async () => {
    await scheduleTask(tdb.pool, { kind: 'k', dedupeKey: 'batch:1' });
    const t = await claimTask(tdb.pool, 'batch:1', 'w', 1_000);
    expect(await rescheduleTask(tdb.pool, t?.id ?? '', 'w', 0)).toBe(true);
    expect(await getTask(tdb.pool, 'batch:1')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await claimTask(tdb.pool, 'batch:1', 'w2', 1_000)).not.toBeNull();
  });
});
