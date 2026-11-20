import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ticketing/testkit';
import { client, type Client } from '../attacker/index.js';
import { bootApi, type BootedApi } from '../helpers/boot.js';
import { createOnSaleEvent, idem, type ApiEvent } from '../helpers/event-fixture.js';
import { createUser, type TestUser } from '../helpers/session.js';

let tdb: TestDb;
let api: BootedApi;
let http: Client;
let orgA: TestUser;
let orgB: TestUser;
let alice: TestUser;
let mallory: TestUser;
let ev: ApiEvent;
let orderId: string;
let itemId: string;

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootApi(tdb);
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.110' });
  [orgA, orgB] = [await createUser(tdb.pool, api.env, 'organizer'), await createUser(tdb.pool, api.env, 'organizer')];
  [alice, mallory] = [await createUser(tdb.pool, api.env), await createUser(tdb.pool, api.env)];
  ev = await createOnSaleEvent(http, tdb.pool, orgA, { seats: 20 });
  const hold = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[0]] }, { token: alice.token, headers: { 'idempotency-key': idem() } });
  const order = hold.json as { id: string; items: { id: string }[] };
  orderId = order.id;
  itemId = order.items[0]?.id ?? '';
});
afterAll(async () => {
  await api.close();
  await tdb.drop();
});

describe('buyers only reach their own orders', () => {
  it.each([
    ['read the order', (t: string) => http.get(`/api/orders/${orderId}`, { token: t })],
    ['read its history', (t: string) => http.get(`/api/orders/${orderId}/history`, { token: t })],
    ['remove an item', (t: string) => http.delete(`/api/orders/${orderId}/items/${itemId}`, { token: t })],
    ['release it', (t: string) => http.post(`/api/orders/${orderId}/release`, {}, { token: t })],
    ['apply a promo to it', (t: string) => http.post(`/api/orders/${orderId}/promo`, { code: 'ANYTHING' }, { token: t })],
    ['remove its promo', (t: string) => http.delete(`/api/orders/${orderId}/promo`, { token: t })],
  ])('another buyer cannot %s (it looks exactly like a missing order)', async (_name, act) => {
    const foreign = await act(mallory.token);
    const missing = await http.get(`/api/orders/${crypto.randomUUID()}`, { token: mallory.token });
    expect(foreign.status).toBe(404);
    expect(foreign.json).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(missing.status).toBe(404);
  });

  it('the list shows only the caller\'s orders and the victim order is intact afterwards', async () => {
    expect((await http.get('/api/orders', { token: mallory.token })).json).toEqual({ items: [] });
    const own = (await http.get('/api/orders', { token: alice.token })).json as { items: { id: string; status: string; items: unknown[] }[] };
    expect(own.items.map((o) => o.id)).toEqual([orderId]);
    expect(own.items[0]).toMatchObject({ status: 'holding' });
    expect(own.items[0]?.items).toHaveLength(1);
  });
});

describe('organizers only reach their own halls, events and promos', () => {
  it.each([
    ['read the hall', () => http.get(`/api/venues/${ev.venueId}`, { token: orgB.token })],
    ['read the hall geometry', () => http.get(`/api/venues/${ev.venueId}/geometry`, { token: orgB.token })],
    ['read the event in the manager view', () => http.get(`/api/organizer/events/${ev.eventId}`, { token: orgB.token })],
    ['read its layout', () => http.get(`/api/organizer/events/${ev.eventId}/layout`, { token: orgB.token })],
    ['edit it', () => http.patch(`/api/organizer/events/${ev.eventId}`, { description: 'pwned' }, { token: orgB.token })],
    ['publish it', () => http.post(`/api/organizer/events/${ev.eventId}/publish`, {}, { token: orgB.token })],
    ['block its seats', () => http.post(`/api/organizer/events/${ev.eventId}/blocked-seats`, { seatIds: [ev.seatIds[3]], blocked: true }, { token: orgB.token })],
    ['create a promo for it', () => http.post('/api/promos', { code: 'STEAL', kind: 'percent', value: 90, usageLimit: 10, eventId: ev.eventId }, { token: orgB.token })],
  ])('organizer B cannot %s', async (_name, act) => {
    const r = await act();
    expect(r.status).toBe(404);
  });

  it('organizer B cannot create an event in organizer A\'s hall', async () => {
    const r = await http.post('/api/organizer/events', {
      venueId: ev.venueId, title: 'Steal', category: 'x', startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), salesStartAt: new Date().toISOString(),
      pricing: { tiers: [{ name: 'T', price: 1_000 }], assignments: [{ tierIndex: 0, zoneIds: [ev.seatedZoneId] }] },
    }, { token: orgB.token });
    expect(r.status).toBe(404);
    expect((await http.get('/api/venues', { token: orgB.token })).json).toEqual({ items: [] });
    expect((await http.get('/api/organizer/events', { token: orgB.token })).json).toMatchObject({ total: 0 });
  });

  it('the event is unchanged after all those attempts', async () => {
    const e = await tdb.pool.query(`SELECT description, status::text AS status, blocked_count FROM events WHERE id = $1`, [ev.eventId]);
    expect(e.rows[0]).toMatchObject({ description: '', status: 'on_sale', blocked_count: 0 });
  });

  it('a draft is invisible to the public and to other organizers, visible to its owner', async () => {
    const venueId = ev.venueId;
    const draft = await http.post('/api/organizer/events', {
      venueId, title: 'Secret draft', category: 'x', startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), salesStartAt: new Date().toISOString(),
      pricing: { tiers: [{ name: 'T', price: 1_000 }], assignments: [{ tierIndex: 0, zoneIds: [ev.seatedZoneId] }] },
    }, { token: orgA.token });
    const id = (draft.json as { id: string }).id;
    expect((await http.get(`/api/events/${id}`)).status).toBe(404);
    expect((await http.get(`/api/events/${id}/layout`)).status).toBe(404);
    expect((await http.get(`/api/events/${id}/seatmap`)).status).toBe(404);
    expect(((await http.get('/api/events', { query: { q: 'Secret draft' } })).json as { total: number }).total).toBe(0);
    expect((await http.get(`/api/organizer/events/${id}`, { token: orgA.token })).status).toBe(200);
    const hold = await http.post(`/api/events/${id}/holds`, { seatIds: [1] }, { token: mallory.token, headers: { 'idempotency-key': idem() } });
    expect(hold.json).toMatchObject({ error: { code: 'EVENT_NOT_ON_SALE' } });
  });
});
