import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENT_STATUSES, EVENT_TRANSITIONS, ORDER_STATUSES, ORDER_TRANSITIONS } from '@ticketing/shared';
import { createTestDb, type TestDb } from '../helpers/test-db.js';
import { createAwaitingOrder, createWorld, insertUser, payOrder, type World } from '../helpers/fixtures.js';

let tdb: TestDb;
let w: World;

beforeAll(async () => {
  tdb = await createTestDb();
  w = await createWorld(tdb.pool, { seats: 30 });
});
afterAll(async () => {
  await tdb.drop();
});

const q = (sql: string, params: readonly unknown[] = []) => tdb.pool.query(sql, [...params]);

describe('seats and capacity', () => {
  it('a held seat must reference an order and an expiry (and the reverse)', async () => {
    const seat = w.seatIds[20];
    await expect(q(`UPDATE event_seats SET status = 'held' WHERE event_id = $1 AND seat_id = $2`, [w.eventId, seat])).rejects.toThrow(/check/);
    await expect(q(`UPDATE event_seats SET hold_order_id = gen_random_uuid() WHERE event_id = $1 AND seat_id = $2`, [w.eventId, seat])).rejects.toThrow(/check/);
  });

  it('two valid tickets on one seat are impossible; a refunded one frees the seat', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [0]);
    await payOrder(tdb.pool, order);
    const insertTicket = (orderId: string, itemId: string) =>
      q(`INSERT INTO tickets (order_id, order_item_id, event_id, owner_id, seat_id, zone_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [orderId, itemId, w.eventId, w.buyerId, w.seatIds[0], w.zoneId]);
    const first = await insertTicket(order.orderId, order.itemIds[0] ?? '');
    const dup = await createAwaitingOrder(tdb.pool, w, [1]);
    await expect(insertTicket(dup.orderId, dup.itemIds[0] ?? '')).rejects.toThrow(/tickets_one_valid_per_seat_idx/);
    await q(`UPDATE tickets SET status = 'refunded' WHERE id = $1`, [(first.rows[0] as { id: string }).id]);
    await expect(insertTicket(dup.orderId, dup.itemIds[0] ?? '')).resolves.toBeDefined();
  });

  it('general-admission counters can never exceed capacity', async () => {
    await expect(q(`UPDATE event_zones SET sold = capacity, held = 1 WHERE event_id = $1`, [w.eventId])).rejects.toThrow(/check/);
    await expect(q(`UPDATE event_zones SET held = -1 WHERE event_id = $1`, [w.eventId])).rejects.toThrow(/check/);
  });

  it('events cannot sell or block more than their capacity, and sales cannot start after the event', async () => {
    await expect(q(`UPDATE events SET sold_count = capacity + 1 WHERE id = $1`, [w.eventId])).rejects.toThrow(/check/);
    await expect(q(`UPDATE events SET sales_start_at = starts_at + interval '1 day' WHERE id = $1`, [w.eventId])).rejects.toThrow(/check/);
    await expect(q(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [w.eventId])).rejects.toThrow(/check/); // cancelled_at is mandatory
  });

  it('promo usage can never exceed its limit; percent over 100 is rejected', async () => {
    await expect(q(`INSERT INTO promo_codes (organizer_id, code, kind, value, usage_limit, used_count) VALUES ($1, 'OVER', 'fixed', 100, 5, 6)`, [w.organizerId])).rejects.toThrow(/check/);
    await expect(q(`INSERT INTO promo_codes (organizer_id, code, kind, value, usage_limit) VALUES ($1, 'BIG', 'percent', 101, 5)`, [w.organizerId])).rejects.toThrow(/check/);
    await expect(q(`INSERT INTO promo_codes (organizer_id, code, kind, value, usage_limit) VALUES ($1, 'lower', 'percent', 10, 5)`, [w.organizerId])).rejects.toThrow(/check/);
  });
});

describe('orders, payments, identity', () => {
  it('order totals must be consistent integers', async () => {
    await expect(q(`INSERT INTO orders (user_id, event_id, subtotal, discount, fee, total) VALUES ($1,$2,1000,0,50,1000)`, [w.buyerId, w.eventId])).rejects.toThrow(/check/);
    await expect(q(`INSERT INTO orders (user_id, event_id, subtotal, discount, fee, total) VALUES ($1,$2,1000,2000,50,-950)`, [w.buyerId, w.eventId])).rejects.toThrow(/check/);
  });

  it('hold timer is fixed once set; paid needs paid_at', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [2]);
    await expect(q(`UPDATE orders SET hold_expires_at = hold_expires_at + interval '5 minutes' WHERE id = $1`, [order.orderId])).rejects.toThrow(/never extends/);
    await expect(q(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.orderId])).rejects.toThrow(/check/);
  });

  it('only one succeeded payment per order', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [3]);
    await q(`UPDATE payments SET status = 'succeeded' WHERE id = $1`, [order.paymentId]);
    await expect(q(`INSERT INTO payments (order_id, amount, status) VALUES ($1, 1, 'succeeded')`, [order.orderId])).rejects.toThrow(/payments_one_success_idx/);
  });

  it('provider event ids are unique (webhook replay protection)', async () => {
    await q(`INSERT INTO payment_events (provider_event_id, kind, payload) VALUES ('evt_1', 'payment.succeeded', '{}')`);
    await expect(q(`INSERT INTO payment_events (provider_event_id, kind, payload) VALUES ('evt_1', 'payment.succeeded', '{}')`)).rejects.toThrow(/duplicate/);
  });

  it('emails are unique case-insensitively (stored lower-cased only)', async () => {
    await expect(q(`INSERT INTO users (email, password_hash, display_name) VALUES ('MiXed@Example.test', 'x', 'n')`)).rejects.toThrow(/check/);
    await insertUser(tdb.pool);
    await q(`INSERT INTO users (email, password_hash, display_name) VALUES ('dup@example.test', 'x', 'n')`);
    await expect(q(`INSERT INTO users (email, password_hash, display_name) VALUES ('dup@example.test', 'x', 'n')`)).rejects.toThrow(/duplicate/);
  });

  it('idempotency keys are unique per user, scope and key', async () => {
    const u = await insertUser(tdb.pool);
    await q(`INSERT INTO idempotency_keys (user_id, scope, key, request_hash) VALUES ($1, 'hold', 'key-12345678', 'h')`, [u]);
    await expect(q(`INSERT INTO idempotency_keys (user_id, scope, key, request_hash) VALUES ($1, 'hold', 'key-12345678', 'h2')`, [u])).rejects.toThrow(/duplicate/);
    await q(`INSERT INTO idempotency_keys (user_id, scope, key, request_hash) VALUES ($1, 'refund', 'key-12345678', 'h')`, [u]);
  });

  it('history and scans are append-only', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [4]);
    await q(`INSERT INTO order_history (order_id, actor_role, type) VALUES ($1, 'system', 'test')`, [order.orderId]);
    await expect(q(`UPDATE order_history SET type = 'x'`)).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM order_history`)).rejects.toThrow(/append-only/);
  });
});

describe('queue, waitlist, tasks', () => {
  it('one queue place per account and event', async () => {
    const u = await insertUser(tdb.pool);
    await q(`INSERT INTO queue_entries (event_id, user_id) VALUES ($1, $2)`, [w.eventId, u]);
    await expect(q(`INSERT INTO queue_entries (event_id, user_id) VALUES ($1, $2)`, [w.eventId, u])).rejects.toThrow(/duplicate/);
  });

  it('queue sequence is strictly increasing', async () => {
    const users = await Promise.all(Array.from({ length: 5 }, () => insertUser(tdb.pool)));
    const seqs: number[] = [];
    for (const u of users) {
      const r = await q(`INSERT INTO queue_entries (event_id, user_id) VALUES ($1, $2) RETURNING seq::int AS seq`, [w.eventId, u]);
      seqs.push((r.rows[0] as { seq: number }).seq);
    }
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('only one active waitlist offer per event', async () => {
    const [u1, u2] = [await insertUser(tdb.pool), await insertUser(tdb.pool)];
    const mkEntry = async (u: string) => ((await q(`INSERT INTO waitlist_entries (event_id, user_id) VALUES ($1,$2) RETURNING id`, [w.eventId, u])).rows[0] as { id: string }).id;
    const [e1, e2] = [await mkEntry(u1), await mkEntry(u2)];
    await q(`INSERT INTO waitlist_offers (entry_id, event_id, user_id, expires_at) VALUES ($1,$2,$3, app_now() + interval '30 minutes')`, [e1, w.eventId, u1]);
    await expect(q(`INSERT INTO waitlist_offers (entry_id, event_id, user_id, expires_at) VALUES ($1,$2,$3, app_now() + interval '30 minutes')`, [e2, w.eventId, u2])).rejects.toThrow(/waitlist_one_active_offer_idx/);
    await q(`UPDATE waitlist_offers SET status = 'expired' WHERE entry_id = $1`, [e1]);
    await q(`INSERT INTO waitlist_offers (entry_id, event_id, user_id, expires_at) VALUES ($1,$2,$3, app_now() + interval '30 minutes')`, [e2, w.eventId, u2]);
  });

  it('task dedupe keys make scheduling idempotent', async () => {
    await q(`INSERT INTO tasks (kind, dedupe_key) VALUES ('expire_hold', 'expire:abc')`);
    await expect(q(`INSERT INTO tasks (kind, dedupe_key) VALUES ('expire_hold', 'expire:abc')`)).rejects.toThrow(/duplicate/);
    const r = await q(`INSERT INTO tasks (kind, dedupe_key) VALUES ('expire_hold', 'expire:abc') ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`);
    expect(r.rowCount).toBe(0);
  });

  it('emails dedupe on their key', async () => {
    await q(`INSERT INTO emails (dedupe_key, to_email, subject, template, message_id) VALUES ('k1', 'a@b.test', 's', 't', '<k1@x>')`);
    await expect(q(`INSERT INTO emails (dedupe_key, to_email, subject, template, message_id) VALUES ('k1', 'a@b.test', 's', 't', '<k1@x>')`)).rejects.toThrow(/duplicate/);
  });
});

describe('state machines: database equals shared tables', () => {
  it('enums match the shared status lists', async () => {
    const enumValues = async (name: string) => (await q(`SELECT unnest(enum_range(NULL::${name}))::text AS v`)).rows.map((r: { v: string }) => r.v);
    expect(await enumValues('order_status')).toEqual([...ORDER_STATUSES]);
    expect(await enumValues('event_status')).toEqual([...EVENT_STATUSES]);
  });

  it('every order status pair is allowed by the trigger exactly when the shared table allows it', async () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (from === to) continue;
        const client = await tdb.pool.connect();
        try {
          await client.query('BEGIN');
          const id = ((await client.query(
            `INSERT INTO orders (user_id, event_id, status, paid_at) VALUES ($1,$2,$3::order_status, CASE WHEN $3 IN ('paid','partially_refunded','refunded') THEN app_now() END) RETURNING id`,
            [w.buyerId, w.eventId, from],
          )).rows[0] as { id: string }).id;
          await client.query('SAVEPOINT s');
          let allowed = true;
          try {
            await client.query(`UPDATE orders SET status = $2::order_status, paid_at = COALESCE(paid_at, app_now()) WHERE id = $1`, [id, to]);
          } catch {
            allowed = false;
          }
          const expected = ORDER_TRANSITIONS.some((r) => r.from === from && r.to === to);
          expect(allowed, `order ${from}->${to}`).toBe(expected);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }
    }
  });

  it('every event status pair matches the shared table', async () => {
    for (const from of EVENT_STATUSES) {
      for (const to of EVENT_STATUSES) {
        if (from === to) continue;
        const client = await tdb.pool.connect();
        try {
          await client.query('BEGIN');
          // Insert directly in the "from" state (INSERT is not guarded), then try to move.
          await client.query(`ALTER TABLE events DISABLE TRIGGER events_guard`);
          await client.query(`UPDATE events SET status = $2::event_status, cancelled_at = CASE WHEN $2 = 'cancelled' THEN app_now() END WHERE id = $1`, [w.eventId, from]);
          await client.query(`ALTER TABLE events ENABLE TRIGGER events_guard`);
          let allowed = true;
          try {
            await client.query(`UPDATE events SET status = $2::event_status, cancelled_at = CASE WHEN $2 = 'cancelled' THEN app_now() END WHERE id = $1`, [w.eventId, to]);
          } catch {
            allowed = false;
          }
          const expected = EVENT_TRANSITIONS.some((r) => r.from === from && r.to === to);
          expect(allowed, `event ${from}->${to}`).toBe(expected);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }
    }
  });
});
