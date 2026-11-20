import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, expectLedgerClean, type TestDb } from '@ticketing/testkit';
import { client, type Client } from '../attacker/index.js';
import { bootApi, type BootedApi } from '../helpers/boot.js';
import { createOnSaleEvent, idem, type ApiEvent } from '../helpers/event-fixture.js';
import { createUser, type TestUser } from '../helpers/session.js';

let tdb: TestDb;
let api: BootedApi;
let http: Client;
let organizer: TestUser;
let buyer: TestUser;
let ev: ApiEvent;

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootApi(tdb);
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.21' });
  organizer = await createUser(tdb.pool, api.env, 'organizer');
  buyer = await createUser(tdb.pool, api.env, 'buyer');
  ev = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 30, floor: 50 });
});
afterAll(async () => {
  await api.close();
  await tdb.drop();
});

describe('end to end through the HTTP API', () => {
  it('registers, logs in and reads its profile', async () => {
    const email = `new-${Date.now()}@example.test`;
    const reg = await http.post('/api/auth/register', { email, password: 'correct-horse-battery', displayName: 'Ann' });
    expect(reg.status).toBe(201);
    const login = await http.post('/api/auth/login', { email, password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
    const me = await http.get('/api/auth/me', { token: (login.json as { accessToken: string }).accessToken });
    expect(me.json).toMatchObject({ email, role: 'buyer' });
  });

  it('publishes an event that search finds, with its layout and live state', async () => {
    const search = await http.get('/api/events', { query: { q: 'Concert', city: 'kyiv', hasSeats: true } });
    expect(search.status).toBe(200);
    const found = (search.json as { items: { id: string }[] }).items.map((i) => i.id);
    expect(found).toContain(ev.eventId);
    const layout = (await http.get(`/api/events/${ev.eventId}/layout`)).json as { seats: { id: number[] }; zones: unknown[]; tiers: unknown[] };
    expect(layout.seats.id).toHaveLength(30);
    const state = (await http.get(`/api/events/${ev.eventId}/seatmap`)).json as { status: number[]; general: { available: number }[] };
    expect(state.status.every((s) => s === 0)).toBe(true);
    expect(state.general[0]?.available).toBe(50);
  });

  it('holds seats and a dance-floor place, prices the order, shows the live state and history', async () => {
    const hold = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: ev.seatIds.slice(0, 2), general: [{ zoneId: ev.floorZoneId, quantity: 2 }] }, { token: buyer.token, headers: { 'idempotency-key': idem() } });
    expect(hold.status).toBe(200);
    const order = hold.json as { id: string; status: string; items: unknown[]; subtotal: number; fee: number; total: number; holdExpiresAt: string; serverTime: string };
    expect(order).toMatchObject({ status: 'holding', subtotal: 400_000, fee: 20_000, total: 420_000 });
    expect(order.items).toHaveLength(4);
    expect(Date.parse(order.holdExpiresAt) - Date.parse(order.serverTime)).toBeGreaterThan(9 * 60_000);
    const state = (await http.get(`/api/events/${ev.eventId}/seatmap`)).json as { status: number[]; heldUntil: unknown[]; general: { available: number }[]; seq: number };
    expect(state.status.filter((s) => s === 1)).toHaveLength(2);
    expect(state.heldUntil).toHaveLength(2);
    expect(state.general[0]?.available).toBe(48);
    expect(state.seq).toBeGreaterThanOrEqual(3);
    const history = (await http.get(`/api/orders/${order.id}/history`, { token: buyer.token })).json as { items: { type: string }[] };
    expect(history.items.map((h) => h.type)).toEqual(['hold_added']);
  });

  it('adding more seats does not extend the timer; removing a seat frees it and reprices', async () => {
    const first = ((await http.get('/api/orders', { token: buyer.token })).json as { items: { id: string; holdExpiresAt: string }[] }).items[0];
    const more = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[5]] }, { token: buyer.token, headers: { 'idempotency-key': idem() } });
    const updated = more.json as { id: string; holdExpiresAt: string; items: { id: string; seatId: number | null }[] };
    expect(updated.id).toBe(first?.id);
    expect(updated.holdExpiresAt).toBe(first?.holdExpiresAt);
    expect(updated.items).toHaveLength(5);
    const victim = updated.items.find((i) => i.seatId === ev.seatIds[5]);
    const removed = await http.delete(`/api/orders/${updated.id}/items/${victim?.id}`, { token: buyer.token });
    expect((removed.json as { items: unknown[]; subtotal: number }).items).toHaveLength(4);
    const state = (await http.get(`/api/events/${ev.eventId}/seatmap`)).json as { status: number[] };
    expect(state.status.filter((s) => s === 1)).toHaveLength(2);
  });

  it('refuses a seventh ticket and enforces the per-order cap', async () => {
    const r = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: ev.seatIds.slice(10, 13), general: [{ zoneId: ev.floorZoneId, quantity: 1 }] }, { token: buyer.token, headers: { 'idempotency-key': idem() } });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: { code: 'LIMIT_EXCEEDED' } });
  });

  it('applies a percent promo to the ticket price only (never to the service fee) and returns the use when removed', async () => {
    const promo = await http.post('/api/promos', { code: 'HALF50', kind: 'percent', value: 50, usageLimit: 5 }, { token: organizer.token });
    expect(promo.status).toBe(201);
    const orderId = ((await http.get('/api/orders', { token: buyer.token })).json as { items: { id: string }[] }).items[0]?.id;
    const before = (await http.get(`/api/orders/${orderId}`, { token: buyer.token })).json as { fee: number };
    const applied = await http.post(`/api/orders/${orderId}/promo`, { code: 'half50' }, { token: buyer.token });
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({ promoCode: 'HALF50', discount: 200_000, fee: before.fee, total: 400_000 - 200_000 + before.fee });
    expect((await tdb.pool.query(`SELECT used_count FROM promo_codes WHERE code = 'HALF50'`)).rows[0]).toMatchObject({ used_count: 1 });
    await http.delete(`/api/orders/${orderId}/promo`, { token: buyer.token });
    expect((await tdb.pool.query(`SELECT used_count FROM promo_codes WHERE code = 'HALF50'`)).rows[0]).toMatchObject({ used_count: 0 });
  });

  it('releasing the order frees everything', async () => {
    const orderId = ((await http.get('/api/orders', { token: buyer.token })).json as { items: { id: string }[] }).items[0]?.id;
    const released = await http.post(`/api/orders/${orderId}/release`, {}, { token: buyer.token });
    expect(released.json).toMatchObject({ status: 'expired' });
    const state = (await http.get(`/api/events/${ev.eventId}/seatmap`)).json as { status: number[]; general: { available: number }[] };
    expect(state.status.every((s) => s === 0)).toBe(true);
    expect(state.general[0]?.available).toBe(50);
    await expectLedgerClean(tdb.pool);
  });

  it('a hold that ran out is gone for everyone by the server clock, even though no worker ever ran', async () => {
    const rival = await createUser(tdb.pool, api.env, 'buyer');
    const mine = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[20]] }, { token: buyer.token, headers: { 'idempotency-key': idem() } });
    expect(mine.status).toBe(200);
    const blocked = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[20]] }, { token: rival.token, headers: { 'idempotency-key': idem() } });
    expect(blocked.json).toMatchObject({ error: { code: 'SEAT_UNAVAILABLE', details: { unavailableSeatIds: [ev.seatIds[20]] } } });
    await http.post('/api/_test/clock', { offsetMs: 11 * 60_000 });
    const state = (await http.get(`/api/events/${ev.eventId}/seatmap`)).json as { status: number[] };
    expect(state.status[20]).toBe(0);
    const taken = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[20]] }, { token: rival.token, headers: { 'idempotency-key': idem() } });
    expect(taken.status).toBe(200);
    const stale = (await http.get(`/api/orders/${(mine.json as { id: string }).id}`, { token: buyer.token })).json as { status: string };
    expect(stale.status).toBe('expired');
    await http.post('/api/_test/clock', { offsetMs: 0 });
  });
});
