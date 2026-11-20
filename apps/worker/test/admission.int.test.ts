import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVirtualQueue } from '@ticketing/platform';
import { createTestDb, createWorld, insertUsers, waitFor, type TestDb } from '@ticketing/testkit';
import { startFakeProvider, type FakeProvider } from './helpers/fake-provider.js';
import { startTestWorker } from './helpers/worker.js';
import type { RunningWorker } from '../src/start-worker.js';

let tdb: TestDb;
let provider: FakeProvider;
let worker: RunningWorker;

beforeAll(async () => {
  tdb = await createTestDb();
  provider = await startFakeProvider();
  worker = startTestWorker({ db: tdb, providerUrl: provider.url, prefix: `a${Math.random().toString(36).slice(2, 8)}`, id: 'admit-worker', queueMaxSelecting: 2 });
});
afterAll(async () => {
  await worker.stop();
  await provider.close();
  await tdb.drop();
});

describe('queue admission by the worker', () => {
  it('lets the next people in, in order, when slots free up - no api request involved', async () => {
    const w = await createWorld(tdb.pool, { seats: 5 });
    const users = await insertUsers(tdb.pool, 6);
    const queue = createVirtualQueue({ pool: tdb.pool, cfg: { activateAt: 0, maxSelecting: 2, startSelectionMs: 300_000, holdTtlMs: 600_000 } });
    for (const u of users) await queue.join(w.eventId, u); // sequential: a known order
    const statuses = async () => (await tdb.pool.query(`SELECT user_id, status::text AS s FROM queue_entries WHERE event_id = $1 ORDER BY seq`, [w.eventId])).rows as { user_id: string; s: string }[];
    expect((await statuses()).map((r) => r.s)).toEqual(['admitted', 'admitted', 'waiting', 'waiting', 'waiting', 'waiting']);
    await queue.finish(w.eventId, users[0] as string, { paid: true });
    await queue.finish(w.eventId, users[1] as string, { paid: true });
    await waitFor(async () => (await statuses()).filter((r) => r.s === 'admitted').length === 2 && (await statuses())[2]?.s === 'admitted', 10_000);
    expect((await statuses()).map((r) => r.s)).toEqual(['done', 'done', 'admitted', 'admitted', 'waiting', 'waiting']);
    await queue.finish(w.eventId, users[2] as string, { paid: false });
    await waitFor(async () => (await statuses())[4]?.s === 'admitted', 10_000);
    expect((await statuses()).map((r) => r.s)).toEqual(['done', 'done', 'done', 'admitted', 'admitted', 'waiting']);
  });

  it('never lets more people select than the capacity, even before the 500-claimant threshold is reached', async () => {
    const w = await createWorld(tdb.pool, { seats: 5 });
    const users = await insertUsers(tdb.pool, 8);
    const queue = createVirtualQueue({ pool: tdb.pool, cfg: { activateAt: 500, maxSelecting: 5, startSelectionMs: 300_000, holdTtlMs: 600_000 } });
    const views = [];
    for (const u of users) views.push(await queue.join(w.eventId, u));
    expect(views.map((v) => v.status)).toEqual(['admitted', 'admitted', 'admitted', 'admitted', 'admitted', 'waiting', 'waiting', 'waiting']);
    expect(views[7]).toMatchObject({ position: 3, queueActive: true });
  });
});
