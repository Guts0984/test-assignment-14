import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, expectLedgerClean, type TestDb } from '@ticketing/testkit';
import { client, statusCounts, type Client } from '../attacker/index.js';
import { bootApi, type BootedApi } from '../helpers/boot.js';
import { createOnSaleEvent, idem, type ApiEvent } from '../helpers/event-fixture.js';
import { createUser, createUsers, type TestUser } from '../helpers/session.js';

let tdb: TestDb;
let api: BootedApi;
let admin: Client;
let organizer: TestUser;
let buyers: readonly TestUser[];
let ev: ApiEvent;

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootApi(tdb);
  admin = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.40' });
  organizer = await createUser(tdb.pool, api.env, 'organizer');
  buyers = await createUsers(tdb.pool, api.env, 200);
  ev = await createOnSaleEvent(admin, tdb.pool, organizer, { seats: 40 });
});
afterAll(async () => {
  await api.close();
  await tdb.drop();
});

const hold = (c: Client, user: TestUser, seatIds: readonly number[], key = idem()) =>
  c.post(`/api/events/${ev.eventId}/holds`, { seatIds }, { token: user.token, headers: { 'idempotency-key': key } });

describe('a seat is sold once', () => {
  it('200 simultaneous attempts on the same two seats: exactly one buyer wins, 199 get a clear refusal', async () => {
    const clients = Array.from({ length: 8 }, (_, i) => client({ baseUrl: api.baseUrl, sourceIp: `127.0.0.${50 + i}` }));
    const replies = await Promise.all(buyers.map((u, i) => hold(clients[i % 8] as Client, u, [ev.seatIds[0] as number, ev.seatIds[1] as number])));
    expect(statusCounts(replies)).toEqual({ 200: 1, 409: 199 });
    expect(replies.filter((r) => r.status === 409).every((r) => (r.json as { error: { code: string } }).error.code === 'SEAT_UNAVAILABLE')).toBe(true);
    const held = await tdb.pool.query(`SELECT hold_order_id, status::text FROM event_seats WHERE event_id = $1 AND seat_id = ANY($2::bigint[])`, [ev.eventId, [ev.seatIds[0], ev.seatIds[1]]]);
    expect(new Set(held.rows.map((r: { hold_order_id: string }) => r.hold_order_id)).size).toBe(1);
    expect(held.rows.every((r: { status: string }) => r.status === 'held')).toBe(true);
    const orders = await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM order_items WHERE event_id = $1`, [ev.eventId]);
    expect(orders.rows[0]).toMatchObject({ n: 2 });
    clients.forEach((c) => c.close());
  });

  it('overlapping multi-seat orders are all-or-nothing: no partial orders, no seat in two orders', async () => {
    const pool = ev.seatIds.slice(10, 22); // 12 contested seats
    const replies = await Promise.all(
      buyers.map((u, i) => {
        const a = pool[i % 12] as number;
        const b = pool[(i * 5 + 3) % 12] as number;
        return hold(admin, u, a === b ? [a, pool[(i + 1) % 12] as number] : [a, b]);
      }),
    );
    const won = replies.filter((r) => r.status === 200).length;
    expect(won).toBeGreaterThanOrEqual(1);
    expect(won).toBeLessThanOrEqual(6);
    expect(replies.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    const seats = await tdb.pool.query(`SELECT seat_id, hold_order_id FROM event_seats WHERE event_id = $1 AND seat_id = ANY($2::bigint[]) AND status = 'held'`, [ev.eventId, pool]);
    expect(seats.rowCount).toBe(won * 2);
    const orders = await tdb.pool.query(
      `SELECT o.id, COUNT(i.id)::int AS items, COUNT(es.seat_id)::int AS held FROM orders o JOIN order_items i ON i.order_id = o.id
       LEFT JOIN event_seats es ON es.event_id = i.event_id AND es.seat_id = i.seat_id AND es.hold_order_id = o.id
       WHERE o.event_id = $1 AND i.seat_id = ANY($2::bigint[]) GROUP BY o.id`,
      [ev.eventId, pool],
    );
    expect(orders.rows.every((r: { items: number; held: number }) => r.items === 2 && r.held === 2)).toBe(true);
    expect(orders.rowCount).toBe(won);
  });

  it('is deterministic about who wins when requests are repeated: the loser keeps getting the same answer', async () => {
    const loser = buyers[199] as TestUser;
    const key = idem();
    const a = await hold(admin, loser, [ev.seatIds[0] as number], key);
    const b = await hold(admin, loser, [ev.seatIds[0] as number], key);
    expect(a.status).toBe(409);
    const strip = (r: { json: unknown }) => ({ ...(r.json as { error: Record<string, unknown> }).error, requestId: undefined });
    expect(strip(b)).toEqual(strip(a)); // same refusal (only the per-request id differs)
  });
});

describe('idempotency', () => {
  it('10 parallel requests with the same key create exactly one order with one result', async () => {
    const user = buyers[0] as TestUser;
    const key = idem();
    const seats = [ev.seatIds[30] as number, ev.seatIds[31] as number];
    const replies = await Promise.all(Array.from({ length: 10 }, () => hold(admin, user, seats, key)));
    expect(statusCounts(replies)).toEqual({ 200: 10 });
    expect(new Set(replies.map((r) => (r.json as { id: string }).id)).size).toBe(1);
    const n = await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.user_id = $1 AND i.seat_id = ANY($2::bigint[])`, [user.id, seats]);
    expect(n.rows[0]).toMatchObject({ n: 2 });
  });

  it('the same key with a different body is refused; a missing key is refused', async () => {
    const user = buyers[1] as TestUser;
    const key = idem();
    expect((await hold(admin, user, [ev.seatIds[35] as number], key)).status).toBe(200);
    const reused = await hold(admin, user, [ev.seatIds[36] as number], key);
    expect(reused.status).toBe(422);
    expect(reused.json).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    const missing = await admin.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[37]] }, { token: user.token });
    expect(missing.status).toBe(400);
    expect(missing.json).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
  });

  it('a key belongs to its user: another user reusing it does not see or replay the first result', async () => {
    const [a, b] = [buyers[2] as TestUser, buyers[3] as TestUser];
    const key = idem();
    const first = await hold(admin, a, [ev.seatIds[38] as number], key);
    const second = await hold(admin, b, [ev.seatIds[39] as number], key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.json as { id: string }).id).not.toBe((first.json as { id: string }).id);
  });

  it('money stays untouched by holds', async () => {
    await expectLedgerClean(tdb.pool);
  });
});
