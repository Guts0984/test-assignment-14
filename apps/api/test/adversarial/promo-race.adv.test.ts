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
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.70' });
  organizer = await createUser(tdb.pool, api.env, 'organizer');
  ev = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 300 });
  const promo = await http.post('/api/promos', { code: 'SALE100', kind: 'fixed', value: 5_000, usageLimit: 100 }, { token: organizer.token });
  expect(promo.status).toBe(201);
});
afterAll(async () => {
  await api.close();
  await tdb.drop();
});

const orderFor = async (user: TestUser, seat: number): Promise<string> => {
  const r = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: [seat] }, { token: user.token, headers: { 'idempotency-key': idem() } });
  return (r.json as { id: string }).id;
};

const usedCount = async (): Promise<number> => ((await tdb.pool.query(`SELECT used_count FROM promo_codes WHERE code = 'SALE100'`)).rows[0] as { used_count: number }).used_count;

describe('promo usage limit', () => {
  it('150 concurrent applications against a limit of 100: exactly 100 pass', async () => {
    const crowd = await createUsers(tdb.pool, api.env, 150);
    const orders = await Promise.all(crowd.map((u, i) => orderFor(u, ev.seatIds[i] as number)));
    const replies = await Promise.all(crowd.map((u, i) => http.post(`/api/orders/${orders[i]}/promo`, { code: 'SALE100' }, { token: u.token })));
    expect(statusCounts(replies)).toEqual({ 200: 100, 422: 50 });
    expect(replies.filter((r) => r.status === 422).every((r) => (r.json as { error: { code: string } }).error.code === 'PROMO_INVALID')).toBe(true);
    expect(await usedCount()).toBe(100);
    const withPromo = await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM orders WHERE promo_held`);
    expect(withPromo.rows[0]).toMatchObject({ n: 100 });
  });

  it('unpaid orders that expired return their promo use: a fresh crowd can use all 100 again', async () => {
    await http.post('/api/_test/clock', { offsetMs: 11 * 60_000 });
    const crowd = await createUsers(tdb.pool, api.env, 120);
    const orders = await Promise.all(crowd.map((u, i) => orderFor(u, ev.seatIds[150 + i] as number)));
    const replies = await Promise.all(crowd.map((u, i) => http.post(`/api/orders/${orders[i]}/promo`, { code: 'SALE100' }, { token: u.token })));
    expect(statusCounts(replies)).toEqual({ 200: 100, 422: 20 });
    expect(await usedCount()).toBe(100);
    const stillHeld = await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM orders WHERE promo_held AND status = 'holding' AND hold_expires_at > app_now()`);
    expect(stillHeld.rows[0]).toMatchObject({ n: 100 });
    await http.post('/api/_test/clock', { offsetMs: 0 });
  });

  it('a promo of another organizer or for another event is refused, and one order takes one promo', async () => {
    await http.post('/api/_test/clock', { offsetMs: 0 });
    const other = await createUser(tdb.pool, api.env, 'organizer');
    await http.post('/api/promos', { code: 'OTHERS', kind: 'percent', value: 10, usageLimit: 5 }, { token: other.token });
    const buyer = await createUser(tdb.pool, api.env);
    const order = await orderFor(buyer, ev.seatIds[290] as number);
    const foreign = await http.post(`/api/orders/${order}/promo`, { code: 'OTHERS' }, { token: buyer.token });
    expect(foreign.json).toMatchObject({ error: { code: 'PROMO_INVALID' } });
    const nope = await http.post(`/api/orders/${order}/promo`, { code: 'NOSUCHCODE' }, { token: buyer.token });
    expect(nope.json).toMatchObject({ error: { code: 'PROMO_INVALID' } });
    expect(await usedCount()).toBe(100);
  });
});
