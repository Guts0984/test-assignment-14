import { afterAll, describe, expect, it } from 'vitest';
import { applyPaymentSucceeded } from '@ticketing/platform';
import { createWorld, expectLedgerClean } from '@ticketing/testkit';
import { api, mintSession, openPool, ops, poll } from '../support.js';

// Acceptance 10, 11 and 12 on the deployed stack: cancel an event with ACC_ORDERS paid orders (default 10 000) while the payment
// stub is in chaos mode, kill -9 the worker, run three worker copies, wipe Redis, then cancel again.
const ORDERS = Number(process.env['ACC_ORDERS'] ?? 10_000);
const pool = openPool();
afterAll(async () => {
  await api('POST', '/api/_test/stub-chaos', undefined, { chaos: false });
  await pool.end();
});

interface Progress { status: string; total: number; requested: number; pending: number; succeeded: number; failed: number }

describe(`mass cancellation of ${ORDERS} orders on the real stack`, () => {
  it('refunds every order exactly once through kill -9, three workers, chaos and a Redis wipe', async () => {
    // A paid world: orders, tickets, payments and ledger entries through the real domain function, plus the provider's own records.
    const world = await createWorld(pool, { seats: ORDERS + 5 });
    const users = await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name, role) SELECT gen_random_uuid() || '@example.test', 'x', 'Bulk', 'buyer' FROM generate_series(1, $1::int) RETURNING id`, [ORDERS]);
    const orders = await pool.query<{ id: string }>(
      `INSERT INTO orders (user_id, event_id, status, hold_expires_at, subtotal, fee, total) SELECT u, $2, 'holding', app_now() + interval '10 minutes', 100000, 5000, 105000 FROM unnest($1::uuid[]) AS u RETURNING id`,
      [users.rows.map((r) => r.id), world.eventId],
    );
    await pool.query(
      `INSERT INTO order_items (order_id, event_id, zone_id, tier_id, seat_id, price, fee)
       SELECT o.id, $2, $3, $4, s.id, 100000, 5000 FROM (SELECT id, row_number() OVER () AS n FROM unnest($1::uuid[]) AS id) o JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM seats WHERE zone_id = $3) s ON s.n = o.n`,
      [orders.rows.map((o) => o.id), world.eventId, world.zoneId, world.tierId],
    );
    await pool.query(`UPDATE event_seats es SET status = 'held', hold_order_id = i.order_id, hold_expires_at = app_now() + interval '10 minutes' FROM order_items i WHERE i.event_id = es.event_id AND i.seat_id = es.seat_id`);
    await pool.query(`UPDATE orders SET status = 'awaiting_payment' WHERE event_id = $1`, [world.eventId]);
    await pool.query(`INSERT INTO payments (order_id, amount, status, provider_payment_id) SELECT id, total, 'pending', 'pay_' || left(replace(id::text, '-', ''), 24) FROM orders WHERE event_id = $1`, [world.eventId]);
    await pool.query(
      `INSERT INTO stub_payments (id, amount, order_ref, status, idempotency_key, request_hash) SELECT p.provider_payment_id, p.amount, p.order_id::text, 'succeeded', 'acc-' || p.id::text, 'acc' FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.event_id = $1`,
      [world.eventId],
    );
    const payments = await pool.query<{ id: string }>(`SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.event_id = $1`, [world.eventId]);
    for (const p of payments.rows) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await applyPaymentSucceeded(c, p.id, 2);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    }
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM tickets WHERE event_id = $1 AND status = 'valid'`, [world.eventId])).rows[0]).toMatchObject({ n: ORDERS });

    ops.scaleWorkers(3);
    expect((await api('POST', '/api/_test/stub-chaos', undefined, { chaos: true })).status).toBeLessThan(300);
    const organizer = await mintSession(pool, world.organizerId, 'organizer');
    const buyer = await mintSession(pool, world.buyerId, 'buyer');

    const started = Date.now();
    const cancel = await api<Progress>('POST', `/api/organizer/events/${world.eventId}/cancel`, organizer);
    expect(cancel.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(30_000);
    // Sales stop at once: nothing can be held, and every ticket is already invalid.
    const hold = await api('POST', `/api/events/${world.eventId}/holds`, buyer, { seatIds: [world.seatIds[0]] });
    expect(hold.status).toBeGreaterThanOrEqual(400);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM tickets WHERE event_id = $1 AND status = 'valid'`, [world.eventId])).rows[0]).toMatchObject({ n: 0 });

    const progress = async (): Promise<Progress> => (await api<Progress>('GET', `/api/organizer/events/${world.eventId}/cancellation`, organizer)).json;
    const seen: number[] = [];
    let killed = false;
    let wiped = false;
    await poll(
      async () => {
        const p = await progress();
        seen.push(p.succeeded);
        if (!killed && p.succeeded >= ORDERS * 0.2) {
          killed = true;
          ops.killWorkers(); // kill -9 on every worker copy in the middle of the cancellation
          ops.scaleWorkers(3); // ... and three fresh copies come back
        }
        if (!wiped && p.succeeded >= ORDERS * 0.5) {
          wiped = true;
          ops.flushRedis();
        }
        return p.succeeded === ORDERS;
      },
      60 * 60_000,
      5_000,
    );
    expect(killed && wiped).toBe(true);
    expect(seen.some((n) => n > 0 && n < ORDERS)).toBe(true); // progress was visible while it ran
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // and only ever moved forward

    const q = async (sql: string) => (await pool.query(sql, [world.eventId])).rows as Record<string, unknown>[];
    expect((await q(`SELECT status::text AS s, COUNT(*)::int AS n FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1 GROUP BY 1`))).toEqual([{ s: 'succeeded', n: ORDERS }]);
    expect((await q(`SELECT COUNT(*)::int AS n FROM ledger_transactions t JOIN refunds r ON r.id::text = t.ref_id::text JOIN orders o ON o.id = r.order_id WHERE t.kind = 'refund' AND o.event_id = $1`))[0]).toMatchObject({ n: ORDERS });
    // The provider saw exactly one accepted refund per payment, and never more than 20 accepted in any one second.
    expect((await q(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT payment_id)::int AS d FROM stub_refunds sr JOIN stub_payments sp ON sp.id = sr.payment_id JOIN orders o ON o.id::text = sp.order_ref WHERE o.event_id = $1`))[0]).toMatchObject({ n: ORDERS, d: ORDERS });
    const burst = await q(`SELECT MAX(c)::int AS m FROM (SELECT COUNT(*) OVER (ORDER BY extract(epoch FROM sr.created_at) RANGE BETWEEN CURRENT ROW AND 0.999 FOLLOWING) AS c FROM stub_refunds sr JOIN stub_payments sp ON sp.id = sr.payment_id JOIN orders o ON o.id::text = sp.order_ref WHERE o.event_id = $1) w`);
    expect(Number(burst[0]?.['m'])).toBeLessThanOrEqual(20);
    expect((await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE kind = 'refund_execute' AND status <> 'done' AND dedupe_key IN (SELECT 'refund_execute:' || r.id FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1)`))[0]).toMatchObject({ n: 0 });

    // Running the cancellation again changes nothing.
    const refundsBefore = (await q(`SELECT COUNT(*)::int AS n FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1`))[0];
    expect((await api('POST', `/api/organizer/events/${world.eventId}/cancel`, organizer)).status).toBe(200);
    expect((await q(`SELECT COUNT(*)::int AS n FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1`))[0]).toEqual(refundsBefore);
    expect(await progress()).toMatchObject({ total: ORDERS, succeeded: ORDERS, failed: 0 });
    await expectLedgerClean(pool);
  }, 90 * 60_000);
});
