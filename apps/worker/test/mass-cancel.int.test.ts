import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelEventInTx, createRedis, restartTask, withTx } from '@ticketing/platform';
import { createTestDb, createTestRedis, expectLedgerClean, waitFor, type TestDb } from '@ticketing/testkit';
import { bulkPaidOrders, type Bulk } from './helpers/bulk.js';
import { startFakeProvider, type FakeProvider } from './helpers/fake-provider.js';
import { startTestWorker } from './helpers/worker.js';
import type { RunningWorker } from '../src/start-worker.js';

const ORDERS = 500;
let tdb: TestDb;
let provider: FakeProvider;
let bulk: Bulk;
const prefix = `c${Math.random().toString(36).slice(2, 8)}`;
let workers: RunningWorker[] = [];

beforeAll(async () => {
  tdb = await createTestDb();
  provider = await startFakeProvider(20);
  bulk = await bulkPaidOrders(tdb.pool, ORDERS, 1);
}, 180_000);
afterAll(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  await provider.close();
  await tdb.drop();
});

const q = async (sql: string, params: unknown[] = []) => (await tdb.pool.query(sql, params)).rows as Record<string, unknown>[];
const refundCounts = async () => Object.fromEntries((await q(`SELECT r.status::text AS s, COUNT(*)::int AS n FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1 GROUP BY 1`, [bulk.world.eventId])).map((r) => [r['s'], r['n']]));

describe('mass cancellation of 500 orders (acceptance 10/11/12, scaled for CI)', () => {
  it('cancelling stops sales at once and creates one refund + task per order in a single step; a second cancel adds nothing', async () => {
    const started = Date.now();
    const first = await withTx(tdb.pool, (tx) => cancelEventInTx(tx, bulk.world.eventId, bulk.world.organizerId));
    expect(first).toEqual({ kind: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await refundCounts()).toEqual({ requested: ORDERS });
    const again = await Promise.all([withTx(tdb.pool, (tx) => cancelEventInTx(tx, bulk.world.eventId, bulk.world.organizerId)), withTx(tdb.pool, (tx) => cancelEventInTx(tx, bulk.world.eventId, bulk.world.organizerId))]);
    expect(again).toEqual([{ kind: 'already_cancelled' }, { kind: 'already_cancelled' }]);
    expect((await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE kind = 'refund_execute'`))[0]).toMatchObject({ n: ORDERS });
    expect((await q(`SELECT COUNT(*)::int AS n FROM tickets WHERE event_id = $1 AND status = 'valid'`, [bulk.world.eventId]))[0]).toMatchObject({ n: 0 });
    expect((await q(`SELECT COUNT(*)::int AS n FROM orders WHERE event_id = $1 AND status = 'refunded'`, [bulk.world.eventId]))[0]).toMatchObject({ n: ORDERS });
  });

  it('three workers in chaos mode, Redis wiped and a worker restarted midway: every order is refunded exactly once and the provider limit is never exceeded', async () => {
    provider.setMode({ chaos: true });
    const start = (id: string) => startTestWorker({ db: tdb, providerUrl: provider.url, prefix, id, refundRps: 15 });
    workers = [start('worker-1'), start('worker-2'), start('worker-3')];
    await waitFor(async () => ((await refundCounts())['succeeded'] ?? 0) >= 120, 60_000);
    expect(provider.maxPerSecond()).toBeLessThanOrEqual(18); // slots of 1000/15 ms shared by all three workers keep calls evenly spread below the provider's 20
    // Redis loses everything while the cancellation is running ...
    const tr = createTestRedis();
    const redis = createRedis(tr.url);
    await redis.flushall();
    await redis.quit();
    await tr.close();
    // ... and one worker is killed (stopped) and a fresh one started
    const [killed] = workers.splice(1, 1);
    await killed?.stop();
    workers.push(start('worker-4'));
    await waitFor(async () => ((await refundCounts())['succeeded'] ?? 0) === ORDERS, 150_000);
    expect(await refundCounts()).toEqual({ succeeded: ORDERS });
    // The provider itself never accepted more than 20 per second. Right after Redis lost the budget counters a one-second
    // burst can be answered with 429; those calls were retried and neither lost nor duplicated a refund (checked below).
    expect(provider.maxAcceptedPerSecond()).toBeLessThanOrEqual(20);
    expect(provider.maxPerSecond()).toBeLessThanOrEqual(2 * 15 + 5);
    expect(provider.refundKeys.size).toBe(ORDERS); // one provider refund per order, however often a call was retried
    expect((await q(`SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = 'refund'`))[0]).toMatchObject({ n: ORDERS });
    expect((await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE kind = 'refund_execute' AND status = 'done'`))[0]).toMatchObject({ n: ORDERS });
    const cash = await q(`SELECT COALESCE(SUM(e.amount), 0)::text AS n FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code = 'provider_cash'`);
    expect(cash[0]).toMatchObject({ n: '0' }); // everything that came in went back out
    await expectLedgerClean(tdb.pool);
  }, 240_000);

  it('the mass-cancel progress task ends and the refunds never exceed what was paid', async () => {
    await waitFor(async () => (await q(`SELECT status::text AS s FROM tasks WHERE kind = 'mass_cancel_notice'`))[0]?.['s'] === 'done', 30_000);
    expect(await q(`SELECT 1 FROM refunds r JOIN orders o ON o.id = r.order_id GROUP BY o.id, o.total HAVING SUM(r.amount) > o.total`)).toEqual([]);
  });
});

describe('provider outages and exhausted retries', () => {
  it('a refund whose provider keeps failing ends as a visible failed task; after the provider recovers finance restarts it and it completes exactly once', async () => {
    const small = await bulkPaidOrders(tdb.pool, 1, 1);
    const item = (await q(`SELECT id FROM order_items WHERE order_id = $1`, [small.orderIds[0]]))[0]?.['id'] as string;
    const { createRefund } = await import('@ticketing/platform');
    provider.setMode({ chaos: false, alwaysDown: true });
    const refundId = await withTx(tdb.pool, (tx) => createRefund(tx, { orderId: small.orderIds[0] as string, kind: 'finance', reason: 'test', requestedBy: small.userIds[0] as string, releaseTickets: true, items: [{ itemId: item, price: 100_000, fee: 5_000 }] }));
    await waitFor(async () => (await q(`SELECT status::text AS s FROM tasks WHERE dedupe_key = $1`, [`refund:${refundId}`]))[0]?.['s'] === 'failed', 60_000);
    const task = (await q(`SELECT attempts, last_error, id FROM tasks WHERE dedupe_key = $1`, [`refund:${refundId}`]))[0];
    expect(task).toMatchObject({ attempts: 8 });
    expect(String(task?.['last_error'])).toContain('provider unavailable');
    expect((await q(`SELECT status::text AS s FROM refunds WHERE id = $1`, [refundId]))[0]).toMatchObject({ s: 'requested' });
    provider.setMode({ alwaysDown: false });
    expect(await restartTask(tdb.pool, task?.['id'] as string)).toBe(true);
    await waitFor(async () => (await q(`SELECT status::text AS s FROM refunds WHERE id = $1`, [refundId]))[0]?.['s'] === 'succeeded', 30_000);
    expect((await q(`SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = 'refund' AND ref_id = $1`, [refundId]))[0]).toMatchObject({ n: 1 });
    await expectLedgerClean(tdb.pool);
  }, 120_000);
});
