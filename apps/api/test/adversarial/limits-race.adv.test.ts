import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ticketing/testkit';
import { client, statusCounts, type Client } from '../attacker/index.js';
import { bootApi, type BootedApi } from '../helpers/boot.js';
import { createOnSaleEvent, idem, type ApiEvent } from '../helpers/event-fixture.js';
import { createUser, createUsers, type TestUser } from '../helpers/session.js';

let tdb: TestDb;
let api: BootedApi;
let http: Client;
let organizer: TestUser;
let ev: ApiEvent;

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootApi(tdb);
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.60' });
  organizer = await createUser(tdb.pool, api.env, 'organizer');
  ev = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 60, floor: 30 });
});
afterAll(async () => {
  await api.close();
  await tdb.drop();
});

const hold = (user: TestUser, body: unknown) => http.post(`/api/events/${ev.eventId}/holds`, body, { token: user.token, headers: { 'idempotency-key': idem() } });

describe('limits hold under parallel orders', () => {
  it('10 parallel 2-ticket orders of one buyer with a limit of 6: exactly 3 succeed, 6 tickets in total', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => hold(buyer, { seatIds: [ev.seatIds[i * 2] as number, ev.seatIds[i * 2 + 1] as number] })));
    expect(statusCounts(replies)).toEqual({ 200: 3, 409: 7 });
    expect(replies.filter((r) => r.status === 409).every((r) => (r.json as { error: { code: string } }).error.code === 'LIMIT_EXCEEDED')).toBe(true);
    const items = await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.user_id = $1`, [buyer.id]);
    expect(items.rows[0]).toMatchObject({ n: 6 });
    const orders = await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1`, [buyer.id]);
    expect(orders.rows[0]).toMatchObject({ n: 1 }); // all merged into the one holding order
  });

  it('an organizer-lowered limit applies, and tickets in other users orders do not count against a buyer', async () => {
    await tdb.pool.query(`UPDATE events SET per_person_limit = 2 WHERE id = $1`, [ev.eventId]);
    const buyer = await createUser(tdb.pool, api.env);
    expect((await hold(buyer, { seatIds: [ev.seatIds[20] as number, ev.seatIds[21] as number] })).status).toBe(200);
    const over = await hold(buyer, { seatIds: [ev.seatIds[22] as number] });
    expect(over.json).toMatchObject({ error: { code: 'LIMIT_EXCEEDED', details: { limit: 2, current: 2 } } });
    const other = await createUser(tdb.pool, api.env);
    expect((await hold(other, { seatIds: [ev.seatIds[22] as number] })).status).toBe(200);
    await tdb.pool.query(`UPDATE events SET per_person_limit = 6 WHERE id = $1`, [ev.eventId]);
  });

  it('dance floor: 40 buyers of 2 places each on a floor of 30 - exactly 15 succeed and the counter never passes capacity', async () => {
    const crowd = await createUsers(tdb.pool, api.env, 40);
    const replies = await Promise.all(crowd.map((u) => hold(u, { general: [{ zoneId: ev.floorZoneId, quantity: 2 }] })));
    expect(statusCounts(replies)).toEqual({ 200: 15, 409: 25 });
    const zone = await tdb.pool.query(`SELECT held, sold, capacity FROM event_zones WHERE event_id = $1 AND zone_id = $2`, [ev.eventId, ev.floorZoneId]);
    expect(zone.rows[0]).toMatchObject({ held: 30, sold: 0, capacity: 30 });
    const items = await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM order_items WHERE event_id = $1 AND zone_id = $2`, [ev.eventId, ev.floorZoneId]);
    expect(items.rows[0]).toMatchObject({ n: 30 });
  });

  it('expired floor holds are reclaimed on demand with the server clock, no worker involved', async () => {
    await http.post('/api/_test/clock', { offsetMs: 11 * 60_000 });
    const crowd = await createUsers(tdb.pool, api.env, 40);
    const replies = await Promise.all(crowd.map((u) => hold(u, { general: [{ zoneId: ev.floorZoneId, quantity: 1 }] })));
    expect(statusCounts(replies)).toEqual({ 200: 30, 409: 10 });
    const zone = await tdb.pool.query(`SELECT held FROM event_zones WHERE event_id = $1 AND zone_id = $2`, [ev.eventId, ev.floorZoneId]);
    expect(zone.rows[0]).toMatchObject({ held: 30 });
    await http.post('/api/_test/clock', { offsetMs: 0 });
  });

  it('sales that have not started, or an unpublished event, refuse holds with a clear code', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    await tdb.pool.query(`UPDATE events SET sales_start_at = app_now() + interval '10 minutes' WHERE id = $1`, [ev.eventId]);
    const early = await hold(buyer, { seatIds: [ev.seatIds[50] as number] });
    expect(early.json).toMatchObject({ error: { code: 'EVENT_NOT_ON_SALE' } });
    await tdb.pool.query(`UPDATE events SET sales_start_at = app_now() - interval '1 hour' WHERE id = $1`, [ev.eventId]);
    expect((await hold(buyer, { seatIds: [ev.seatIds[50] as number] })).status).toBe(200);
  });
});
