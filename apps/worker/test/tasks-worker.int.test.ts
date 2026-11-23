import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyPaymentSucceeded, createRedis } from '@ticketing/platform';
import { createTestDb, createTestRedis, createWorld, expectLedgerClean, insertUsers, setClockOffset, waitFor, type TestDb } from '@ticketing/testkit';
import { startFakeProvider, type FakeProvider } from './helpers/fake-provider.js';
import { bulkPaidOrders } from './helpers/bulk.js';
import { startTestWorker } from './helpers/worker.js';
import type { RunningWorker } from '../src/start-worker.js';

let tdb: TestDb;
let provider: FakeProvider;
let workers: RunningWorker[] = [];
const prefix = `w${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  tdb = await createTestDb();
  provider = await startFakeProvider();
  workers = [startTestWorker({ db: tdb, providerUrl: provider.url, prefix, id: 'worker-a' }), startTestWorker({ db: tdb, providerUrl: provider.url, prefix, id: 'worker-b' })];
});
afterEach(async () => {
  await setClockOffset(tdb.pool, 0);
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  await provider.close();
  await tdb.drop();
});

const q = async (sql: string, params: unknown[] = []) => (await tdb.pool.query(sql, params)).rows as Record<string, unknown>[];

const holdDirect = async (eventId: string, zoneId: string, tierId: string, seatId: number, userId: string, over?: { promoId?: string }) => {
  const order = (await q(`INSERT INTO orders (user_id, event_id, status, hold_expires_at, subtotal, fee, total, promo_id, promo_held) VALUES ($1, $2, 'holding', app_now() + interval '10 minutes', 100000, 5000, 105000, $3, $4) RETURNING id`, [userId, eventId, over?.promoId ?? null, Boolean(over?.promoId)]))[0]?.['id'] as string;
  await q(`INSERT INTO order_items (order_id, event_id, zone_id, tier_id, seat_id, price, fee) VALUES ($1,$2,$3,$4,$5,100000,5000)`, [order, eventId, zoneId, tierId, seatId]);
  await q(`UPDATE event_seats SET status = 'held', hold_order_id = $1, hold_expires_at = app_now() + interval '10 minutes' WHERE event_id = $2 AND seat_id = $3`, [order, eventId, seatId]);
  await q(`INSERT INTO tasks (kind, dedupe_key, payload, run_at) VALUES ('hold_expire', $1, $2::jsonb, app_now() + interval '10 minutes')`, [`hold_expire:${order}`, JSON.stringify({ orderId: order })]);
  return order;
};

describe('hold expiry by the worker', () => {
  it('releases seats, floor places and the promo use when the (mocked) clock passes the hold - once, on either worker', async () => {
    const w = await createWorld(tdb.pool, { seats: 6 });
    const [u1, u2] = await insertUsers(tdb.pool, 2);
    const promo = (await q(`INSERT INTO promo_codes (organizer_id, code, kind, value, usage_limit, used_count) VALUES ($1, 'EXP10', 'percent', 10, 5, 1) RETURNING id`, [w.organizerId]))[0]?.['id'] as string;
    const o1 = await holdDirect(w.eventId, w.zoneId, w.tierId, w.seatIds[0] as number, u1 as string, { promoId: promo });
    const o2 = await holdDirect(w.eventId, w.zoneId, w.tierId, w.seatIds[1] as number, u2 as string);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await q(`SELECT status::text AS s FROM orders WHERE id = ANY($1::uuid[]) ORDER BY id`, [[o1, o2]])).toEqual([{ s: 'holding' }, { s: 'holding' }]);
    await setClockOffset(tdb.pool, 10 * 60_000 + 1_000);
    await waitFor(async () => (await q(`SELECT COUNT(*)::int AS n FROM orders WHERE id = ANY($1::uuid[]) AND status = 'expired'`, [[o1, o2]]))[0]?.['n'] === 2, 20_000);
    expect(await q(`SELECT status::text AS s FROM event_seats WHERE event_id = $1 AND seat_id = ANY($2::bigint[])`, [w.eventId, [w.seatIds[0], w.seatIds[1]]])).toEqual([{ s: 'free' }, { s: 'free' }]);
    expect((await q(`SELECT used_count FROM promo_codes WHERE id = $1`, [promo]))[0]).toMatchObject({ used_count: 0 });
    expect((await q(`SELECT COUNT(*)::int AS n FROM order_history WHERE order_id = ANY($1::uuid[]) AND type = 'hold_expired'`, [[o1, o2]]))[0]).toMatchObject({ n: 2 });
    await waitFor(async () => (await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE kind = 'hold_expire' AND status = 'done' AND dedupe_key = ANY($1::text[])`, [[`hold_expire:${o1}`, `hold_expire:${o2}`]]))[0]?.['n'] === 2, 15_000);
  });

  it('the safety sweep releases holds even when their task was lost', async () => {
    const w = await createWorld(tdb.pool, { seats: 3 });
    const [u] = await insertUsers(tdb.pool, 1);
    const order = await holdDirect(w.eventId, w.zoneId, w.tierId, w.seatIds[0] as number, u as string);
    await q(`DELETE FROM tasks WHERE dedupe_key = $1`, [`hold_expire:${order}`]);
    await setClockOffset(tdb.pool, 10 * 60_000 + 30_000);
    await waitFor(async () => (await q(`SELECT status::text AS s FROM orders WHERE id = $1`, [order]))[0]?.['s'] === 'expired', 10_000);
  });
});

describe('payout 3 days after the event (acceptance: payout = sales - refunds - commission)', () => {
  it('finishes the event and pays the organizer exactly once, with the 8% commission rounded in their favour', async () => {
    const bulk = await bulkPaidOrders(tdb.pool, 7, 1); // 7 x 1000 UAH of ticket sales
    const w = bulk.world;
    // one ticket gets refunded before the payout
    const item = (await q(`SELECT id FROM order_items WHERE order_id = $1`, [bulk.orderIds[0]]))[0]?.['id'] as string;
    const c = await tdb.pool.connect();
    try {
      await c.query('BEGIN');
      const { createRefund, applyRefundSucceeded } = await import('@ticketing/platform');
      const refundId = await createRefund(c, { orderId: bulk.orderIds[0] as string, kind: 'user', reason: null, requestedBy: bulk.userIds[0] as string, releaseTickets: true, items: [{ itemId: item, price: 100_000, fee: 0 }] });
      await applyRefundSucceeded(c, refundId, 'ref_manual');
      await c.query(`UPDATE tasks SET status = 'done' WHERE dedupe_key = $1`, [`refund:${refundId}`]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const starts = (await q(`SELECT starts_at FROM events WHERE id = $1`, [w.eventId]))[0]?.['starts_at'] as Date;
    await q(`INSERT INTO tasks (kind, dedupe_key, payload, run_at) VALUES ('event_finish', $1, $2::jsonb, app_now()), ('payout', $3, $2::jsonb, app_now())`, [`event_finish:${w.eventId}:${starts.getTime()}`, JSON.stringify({ eventId: w.eventId, startsAtMs: starts.getTime() }), `payout:${w.eventId}:${starts.getTime()}`]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await q(`SELECT COUNT(*)::int AS n FROM payouts WHERE event_id = $1`, [w.eventId]))[0]).toMatchObject({ n: 0 }); // 30 days before the event: nothing yet
    await setClockOffset(tdb.pool, 33 * 86_400_000); // 3 days after the start
    await waitFor(async () => (await q(`SELECT status::text AS s FROM events WHERE id = $1`, [w.eventId]))[0]?.['s'] === 'paid_out', 25_000);
    const p = (await q(`SELECT sales::int, refunds::int, commission::int, amount::int, status::text AS status FROM payouts WHERE event_id = $1`, [w.eventId]))[0];
    expect(p).toMatchObject({ sales: 700_000, refunds: 100_000, commission: 48_000, amount: 552_000, status: 'paid' }); // 600 000 net, 8% = 48 000
    expect(p?.['amount']).toBe((p?.['sales'] as number) - (p?.['refunds'] as number) - (p?.['commission'] as number));
    const payable = await q(`SELECT balance::text AS b FROM accounts WHERE code = $1`, [`organizer_payable:${w.organizerId}`]);
    expect(payable[0]).toMatchObject({ b: '0' });
    expect((await q(`SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = 'payout'`))[0]).toMatchObject({ n: 1 });
    await expectLedgerClean(tdb.pool);
  });

  it('waits while a refund is owed (rejected by the provider) and pays out only after it is settled, net of it', async () => {
    const bulk = await bulkPaidOrders(tdb.pool, 3, 1); // 3 x 1000 UAH
    const w = bulk.world;
    const { createRefund, applyRefundFailed, applyRefundSucceeded, retryRefund } = await import('@ticketing/platform');
    const item = (await q(`SELECT id FROM order_items WHERE order_id = $1`, [bulk.orderIds[0]]))[0]?.['id'] as string;
    const tx = async <T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const c = await tdb.pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
      } finally {
        c.release();
      }
    };
    const refundId = await tx(async (c) => {
      const id = await createRefund(c, { orderId: bulk.orderIds[0] as string, kind: 'user', reason: null, requestedBy: bulk.userIds[0] as string, releaseTickets: true, items: [{ itemId: item, price: 100_000, fee: 0 }] });
      await c.query(`UPDATE tasks SET status = 'done' WHERE dedupe_key = $1`, [`refund:${id}`]);
      await applyRefundFailed(c, id); // the provider said no: the buyer is still owed 1000 UAH
      return id;
    });
    const starts = (await q(`SELECT starts_at FROM events WHERE id = $1`, [w.eventId]))[0]?.['starts_at'] as Date;
    const payoutKey = `payout:${w.eventId}:${starts.getTime()}`;
    await q(`INSERT INTO tasks (kind, dedupe_key, payload, run_at) VALUES ('payout', $1, $2::jsonb, app_now())`, [payoutKey, JSON.stringify({ eventId: w.eventId, startsAtMs: starts.getTime() })]);
    await setClockOffset(tdb.pool, 33 * 86_400_000);
    // the payout task ran and chose to wait (it was rescheduled, not finished)
    await waitFor(async () => Number((await q(`SELECT attempts FROM tasks WHERE dedupe_key = $1`, [payoutKey]))[0]?.['attempts'] ?? 0) >= 1, 15_000);
    expect((await q(`SELECT COUNT(*)::int AS n FROM payouts WHERE event_id = $1`, [w.eventId]))[0]).toMatchObject({ n: 0 });
    expect((await q(`SELECT status::text AS s FROM tasks WHERE dedupe_key = $1`, [payoutKey]))[0]?.['s']).not.toBe('done');

    // finance retries and the provider accepts this time
    expect(await tx((c) => retryRefund(c, refundId, w.organizerId))).toBe('retried');
    await tx(async (c) => applyRefundSucceeded(c, refundId, 'ref_retry'));
    await q(`UPDATE tasks SET run_at = app_now() WHERE dedupe_key = $1`, [payoutKey]); // skip the 30 s wait
    await waitFor(async () => (await q(`SELECT status::text AS s FROM events WHERE id = $1`, [w.eventId]))[0]?.['s'] === 'paid_out', 25_000);
    const p = (await q(`SELECT sales::int, refunds::int, commission::int, amount::int FROM payouts WHERE event_id = $1`, [w.eventId]))[0];
    expect(p).toMatchObject({ sales: 300_000, refunds: 100_000, commission: 16_000, amount: 184_000 });
    expect(await tx((c) => retryRefund(c, refundId, w.organizerId))).toBe('paid_out'); // nothing can be retried into a paid-out balance
    await expectLedgerClean(tdb.pool);
  }, 60_000);

  it('a payout task for the old date does nothing after a reschedule, and a cancelled event is never paid out', async () => {
    const w = await createWorld(tdb.pool, { seats: 3 });
    await q(`INSERT INTO tasks (kind, dedupe_key, payload, run_at) VALUES ('payout', $1, $2::jsonb, app_now())`, [`payout:${w.eventId}:1`, JSON.stringify({ eventId: w.eventId, startsAtMs: 1 })]);
    await q(`UPDATE events SET status = 'cancelled', cancelled_at = app_now() WHERE id = $1`, [w.eventId]);
    await setClockOffset(tdb.pool, 40 * 86_400_000);
    await waitFor(async () => (await q(`SELECT status::text AS s FROM tasks WHERE dedupe_key = $1`, [`payout:${w.eventId}:1`]))[0]?.['s'] === 'done', 15_000);
    expect((await q(`SELECT COUNT(*)::int AS n FROM payouts WHERE event_id = $1`, [w.eventId]))[0]).toMatchObject({ n: 0 });
  });
});

describe('the worker survives Redis losing everything', () => {
  it('tasks scheduled in Postgres still run after FLUSH, and nothing runs twice', async () => {
    const w = await createWorld(tdb.pool, { seats: 20 });
    const users = await insertUsers(tdb.pool, 12);
    const orders: string[] = [];
    for (const [i, u] of users.entries()) orders.push(await holdDirect(w.eventId, w.zoneId, w.tierId, w.seatIds[i] as number, u));
    const tr = createTestRedis();
    const bull = createRedis(tr.url);
    await bull.flushall();
    await bull.quit();
    await tr.close();
    await setClockOffset(tdb.pool, 10 * 60_000 + 1_000);
    await waitFor(async () => (await q(`SELECT COUNT(*)::int AS n FROM orders WHERE id = ANY($1::uuid[]) AND status = 'expired'`, [orders]))[0]?.['n'] === 12, 25_000);
    expect((await q(`SELECT COUNT(*)::int AS n FROM order_history WHERE order_id = ANY($1::uuid[]) AND type = 'hold_expired'`, [orders]))[0]).toMatchObject({ n: 12 });
    void applyPaymentSucceeded;
  });
});
