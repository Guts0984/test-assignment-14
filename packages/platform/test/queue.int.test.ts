import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, createTestRedis, createWorld, insertUsers, setClockOffset, type TestDb, type TestRedis, type World } from '@ticketing/testkit';
import { createRedisQueueCache, createVirtualQueue, type QueueConfig } from '../src/index.js';

let tdb: TestDb;
let tr: TestRedis;
let users: readonly string[];

beforeAll(async () => {
  tdb = await createTestDb();
  tr = createTestRedis(14);
  users = await insertUsers(tdb.pool, 700);
});
afterEach(async () => {
  await setClockOffset(tdb.pool, 0);
});
afterAll(async () => {
  await tr.close();
  await tdb.drop();
});

const cfg = (over: Partial<QueueConfig> = {}): QueueConfig => ({ activateAt: 0, maxSelecting: 20, startSelectionMs: 5 * 60_000, holdTtlMs: 10 * 60_000, ...over });
const freshEvent = async (): Promise<World> => createWorld(tdb.pool, { seats: 10 });
const seqOf = async (eventId: string, userId: string): Promise<number> =>
  Number(((await tdb.pool.query(`SELECT seq FROM queue_entries WHERE event_id = $1 AND user_id = $2`, [eventId, userId])).rows[0] as { seq: string }).seq);
const statusCounts = async (eventId: string): Promise<Record<string, number>> =>
  Object.fromEntries((await tdb.pool.query(`SELECT status::text, COUNT(*)::int AS n FROM queue_entries WHERE event_id = $1 GROUP BY 1`, [eventId])).rows.map((r: { status: string; n: number }) => [r.status, r.n]));

describe('virtual queue fairness and capacity', () => {
  it('queue mode stays off below the threshold: everyone is admitted at once', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ activateAt: 50, maxSelecting: 50 }) });
    const views = await Promise.all(users.slice(0, 30).map((u) => q.join(w.eventId, u)));
    expect(views.every((v) => v.status === 'admitted' && !v.queueActive)).toBe(true);
    expect(await q.mustWait(w.eventId, users[0] ?? '')).toBe(false);
  });

  it('queue mode turns on above the threshold; later arrivals wait', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ activateAt: 5, maxSelecting: 3 }) });
    for (const u of users.slice(0, 5)) await q.join(w.eventId, u);
    const sixth = await q.join(w.eventId, users[5] ?? '');
    expect(sixth).toMatchObject({ status: 'waiting', queueActive: true });
    expect(await q.mustWait(w.eventId, users[5] ?? '')).toBe(true);
  });

  it('500 simultaneous joiners: exactly `maxSelecting` are admitted, they are the first by join order, positions are 1..N without gaps', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg() });
    await Promise.all(users.slice(0, 500).map((u) => q.join(w.eventId, u)));
    const counts = await statusCounts(w.eventId);
    expect(counts).toEqual({ admitted: 20, waiting: 480 });
    const admittedMax = Number(((await tdb.pool.query(`SELECT MAX(seq) AS m FROM queue_entries WHERE event_id = $1 AND status = 'admitted'`, [w.eventId])).rows[0] as { m: string }).m);
    const waitingMin = Number(((await tdb.pool.query(`SELECT MIN(seq) AS m FROM queue_entries WHERE event_id = $1 AND status = 'waiting'`, [w.eventId])).rows[0] as { m: string }).m);
    expect(admittedMax).toBeLessThan(waitingMin);
    const positions = (await Promise.all(users.slice(0, 500).map((u) => q.view(w.eventId, u)))).flatMap((v) => (v?.position ? [v.position] : []));
    expect([...positions].sort((a, b) => a - b)).toEqual(Array.from({ length: 480 }, (_, i) => i + 1));
  });

  it('a storm of 60 concurrent admission rounds (api copies + worker) still never exceeds the capacity', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 7 }) });
    await Promise.all(users.slice(0, 100).map((u) => q.join(w.eventId, u)));
    await Promise.all(Array.from({ length: 60 }, () => q.admit(w.eventId)));
    expect((await statusCounts(w.eventId))['admitted']).toBe(7);
    expect(await q.activeCount(w.eventId)).toBe(7);
  });

  it('admits strictly in join order while slots are freed and refilled concurrently', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 10 }) });
    const crowd = users.slice(0, 200);
    await Promise.all(crowd.map((u) => q.join(w.eventId, u)));
    const batches: string[][] = [];
    const initial = (await tdb.pool.query(`SELECT user_id FROM queue_entries WHERE event_id = $1 AND status = 'admitted'`, [w.eventId])).rows.map((r: { user_id: string }) => r.user_id);
    batches.push(initial);
    let active = [...initial];
    while (active.length > 0) {
      await Promise.all(active.map((u) => q.finish(w.eventId, u, { paid: true })));
      const results = await Promise.all(Array.from({ length: 5 }, () => q.admit(w.eventId)));
      const got = results.flat();
      if (got.length > 0) batches.push([...got]);
      active = got;
    }
    const seqs = new Map<string, number>();
    for (const u of crowd) seqs.set(u, await seqOf(w.eventId, u));
    const flattened = batches.map((b) => b.map((u) => seqs.get(u) ?? -1).sort((a, b) => a - b));
    for (let i = 1; i < flattened.length; i += 1) {
      expect(Math.min(...(flattened[i] ?? [])), `batch ${i} starts after batch ${i - 1}`).toBeGreaterThan(Math.max(...(flattened[i - 1] ?? [])));
    }
    expect(batches.flat()).toHaveLength(200); // everyone was served exactly once
    expect(new Set(batches.flat()).size).toBe(200);
  });

  it('one account is one place: 40 parallel joins, a reload and a second tab all see the same place', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 1 }) });
    await q.join(w.eventId, users[0] ?? ''); // takes the only slot
    const views = await Promise.all(Array.from({ length: 40 }, () => q.join(w.eventId, users[1] ?? '')));
    expect(new Set(views.map((v) => v.position)).size).toBe(1);
    expect((await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM queue_entries WHERE event_id = $1 AND user_id = $2`, [w.eventId, users[1]])).rows[0]).toMatchObject({ n: 1 });
    const before = await seqOf(w.eventId, users[1] ?? '');
    await q.join(w.eventId, users[1] ?? '');
    expect(await seqOf(w.eventId, users[1] ?? '')).toBe(before);
  });

  it('limit 1: the second buyer waits and is admitted only after the first finishes', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 1 }) });
    const [a, b] = [users[10] ?? '', users[11] ?? ''];
    expect((await q.join(w.eventId, a)).status).toBe('admitted');
    expect((await q.join(w.eventId, b)).status).toBe('waiting');
    expect(await q.admit(w.eventId)).toEqual([]);
    await q.finish(w.eventId, a, { paid: true });
    expect(await q.admit(w.eventId)).toEqual([b]);
    expect((await q.view(w.eventId, b))?.status).toBe('admitted');
  });

  it('an admitted person who does not start selecting within 5 minutes loses the slot to the next one (server clock)', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 2 }) });
    const crowd = users.slice(20, 26);
    for (const u of crowd) await q.join(w.eventId, u);
    const [a, b, c, d] = crowd;
    expect(await q.startSelecting(w.eventId, a ?? '')).toBe('ok');
    await setClockOffset(tdb.pool, 5 * 60_000 + 1_000);
    expect(await q.startSelecting(w.eventId, b ?? '')).toBe('not_admitted'); // too late, decided without any worker
    const next = await q.admit(w.eventId);
    expect(next).toEqual([c]); // `a` is still selecting and keeps one of the two slots; b expired, so exactly one is free
    expect(d).toBeDefined();
    await setClockOffset(tdb.pool, 0);
  });

  it('only an admitted person can start selecting; a waiting person cannot jump the line', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 1 }) });
    await q.join(w.eventId, users[30] ?? '');
    await q.join(w.eventId, users[31] ?? '');
    expect(await q.startSelecting(w.eventId, users[31] ?? '')).toBe('not_admitted');
    expect(await q.startSelecting(w.eventId, users[99] ?? '')).toBe('not_admitted'); // never joined
    expect(await q.startSelecting(w.eventId, users[30] ?? '')).toBe('ok');
    expect(await q.startSelecting(w.eventId, users[30] ?? '')).toBe('ok'); // idempotent
  });

  it('a selecting person frees the slot when the hold lifetime ends, and a left person can rejoin at the back', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 1 }) });
    const [a, b, c] = [users[40] ?? '', users[41] ?? '', users[42] ?? ''];
    await q.join(w.eventId, a);
    await q.join(w.eventId, b);
    await q.join(w.eventId, c);
    await q.startSelecting(w.eventId, a);
    await setClockOffset(tdb.pool, 10 * 60_000 + 1_000);
    expect(await q.admit(w.eventId)).toEqual([b]);
    await q.leave(w.eventId, b);
    const rejoined = await q.join(w.eventId, b);
    expect(rejoined.status).toBe('waiting');
    expect(rejoined.position).toBe(1); // c was admitted into the freed slot; b re-enters behind everyone
    expect((await q.view(w.eventId, c))?.status).toBe('admitted');
    expect(await seqOf(w.eventId, b)).toBeGreaterThan(await seqOf(w.eventId, c));
    await setClockOffset(tdb.pool, 0);
  });

  it('the mode switches off when nobody is left', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 5 }) });
    await q.join(w.eventId, users[50] ?? '');
    await q.finish(w.eventId, users[50] ?? '', { paid: true });
    await q.admit(w.eventId);
    expect((await tdb.pool.query(`SELECT queue_active FROM events WHERE id = $1`, [w.eventId])).rows[0]).toMatchObject({ queue_active: false });
    expect((await tdb.pool.query(`SELECT paid FROM queue_entries WHERE event_id = $1 AND user_id = $2`, [w.eventId, users[50]])).rows[0]).toMatchObject({ paid: true });
  });

  it('wait estimates never shrink for people further back', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 5 }) });
    for (const u of users.slice(60, 90)) await q.join(w.eventId, u);
    const views = await Promise.all(users.slice(60, 90).map((u) => q.view(w.eventId, u)));
    const waiting = views.flatMap((v) => (v && v.position !== null ? [v] : [])).sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
    for (let i = 1; i < waiting.length; i += 1) expect(waiting[i]?.etaSeconds ?? 0).toBeGreaterThanOrEqual(waiting[i - 1]?.etaSeconds ?? 0);
  });
});

describe('Redis is only a cache of the queue', () => {
  it('FLUSH of Redis keeps every place and the same order', async () => {
    const w = await freshEvent();
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 5 }), cache: createRedisQueueCache(tr.redis, tr.prefix) });
    const crowd = users.slice(100, 160);
    for (const u of crowd) await q.join(w.eventId, u); // sequential: a known order
    const before = await Promise.all(crowd.map((u) => q.view(w.eventId, u)));
    await tr.redis.flushdb();
    const after = await Promise.all(crowd.map((u) => q.view(w.eventId, u)));
    expect(after.map((v) => v?.position)).toEqual(before.map((v) => v?.position));
    expect(after.map((v) => v?.status)).toEqual(before.map((v) => v?.status));
    expect(await tr.redis.zrange(`${tr.prefix}:${w.eventId}:waiting`, 0, -1)).toEqual(crowd.slice(5)); // rebuilt in join order
  });

  it('works with a cache that throws (Redis down): positions come from Postgres', async () => {
    const w = await freshEvent();
    const broken = {
      onJoined: () => Promise.reject(new Error('redis down')),
      onLeft: () => Promise.reject(new Error('redis down')),
      position: () => Promise.reject(new Error('redis down')),
      rebuild: () => Promise.reject(new Error('redis down')),
    };
    const q = createVirtualQueue({ pool: tdb.pool, cfg: cfg({ maxSelecting: 1 }), cache: broken });
    await q.join(w.eventId, users[170] ?? '');
    const second = await q.join(w.eventId, users[171] ?? '');
    expect(second).toMatchObject({ status: 'waiting', position: 1 });
    await q.finish(w.eventId, users[170] ?? '', { paid: false });
    expect(await q.admit(w.eventId)).toEqual([users[171]]);
  });
});
