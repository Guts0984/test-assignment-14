import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, waitFor, type TestDb } from '@ticketing/testkit';
import { client, statusCounts } from '../attacker/index.js';
import { bootApi } from '../helpers/boot.js';
import { createOnSaleEvent, idem, type ApiEvent } from '../helpers/event-fixture.js';
import { bootLoop } from '../helpers/full-stack.js';
import { bindPool, drainTasks, holdSeats, payFully, providerOf, setClock } from '../helpers/flow.js';
import { createUser, createUsers, type TestUser } from '../helpers/session.js';

let tdb: TestDb;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  for (const close of closers) await close();
  await tdb.drop();
});

const q = async (sql: string, params: unknown[] = []) => (await tdb.pool.query(sql, params)).rows as Record<string, unknown>[];

describe('waitlist (acceptance 14)', () => {
  it('a refund on a sold-out event offers the seat to the first person only; unpaid after 30 minutes it goes to the second', async () => {
    const api = await bootLoop(tdb);
    closers.push(api.close);
    bindPool(api, tdb.pool);
    const http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.150' });
    const organizer = await createUser(tdb.pool, api.env, 'organizer');
    const ev: ApiEvent = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 4 });
    const owners = await createUsers(tdb.pool, api.env, 4);
    const orders = [];
    for (const [i, o] of owners.entries()) {
      const order = await holdSeats(http, ev.eventId, o, [ev.seatIds[i] as number]);
      await payFully(api, http, o, order.id);
      orders.push(order);
    }
    expect(((await http.get(`/api/events/${ev.eventId}`)).json as { status: string }).status).toBe('sold_out');
    const [w1, w2, w3, rival] = await createUsers(tdb.pool, api.env, 4);
    const join = (u: TestUser) => http.post(`/api/events/${ev.eventId}/waitlist`, {}, { token: u.token });
    for (const [i, w] of [w1, w2, w3].entries()) expect((await join(w as TestUser)).json).toMatchObject({ joined: true, position: i + 1, offer: null });
    const stillOnSale = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 3 });
    expect((await http.post(`/api/events/${stillOnSale.eventId}/waitlist`, {}, { token: (w1 as TestUser).token })).json).toMatchObject({ error: { code: 'CONFLICT' } });

    // seat 0 is returned
    const refund = await http.post(`/api/orders/${orders[0]?.id}/refund`, {}, { token: (owners[0] as TestUser).token, headers: { 'idempotency-key': idem() } });
    expect(refund.status).toBe(200);
    const s1 = (await http.get(`/api/events/${ev.eventId}/waitlist`, { token: (w1 as TestUser).token })).json as { offer: { seatId: number; expiresAt: string; id: string } | null; serverTime: string };
    expect(s1.offer?.seatId).toBe(ev.seatIds[0]);
    expect(Date.parse(s1.offer?.expiresAt ?? '') - Date.parse(s1.serverTime)).toBeGreaterThan(29 * 60_000);
    expect((await http.get(`/api/events/${ev.eventId}/waitlist`, { token: (w2 as TestUser).token })).json).toMatchObject({ offer: null, position: 1 });
    expect((await q(`SELECT COUNT(*)::int AS n FROM waitlist_offers WHERE event_id = $1 AND status = 'active'`, [ev.eventId]))[0]?.['n']).toBe(1);
    const state = (await http.get(`/api/events/${ev.eventId}/seatmap`)).json as { status: number[] };
    expect(state.status[0]).toBe(1); // reserved: nobody else sees it as free
    const blocked = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[0]] }, { token: (rival as TestUser).token, headers: { 'idempotency-key': idem() } });
    expect(blocked.json).toMatchObject({ error: { code: 'SEAT_UNAVAILABLE' } });
    expect((await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE dedupe_key = $1`, [`waitlist_expire:${s1.offer?.id}`]))[0]?.['n']).toBe(1);

    // w1 never pays
    await setClock(http, 31 * 60_000);
    expect(((await http.get(`/api/events/${ev.eventId}/seatmap`)).json as { status: number[] }).status[0]).toBe(0); // the offer is over by the server clock
    await q(`SELECT waitlist_offer_next($1)`, [ev.eventId]); // what the worker's expiry task does
    expect((await http.get(`/api/events/${ev.eventId}/waitlist`, { token: (w1 as TestUser).token })).json).toMatchObject({ joined: false, offer: null });
    const s2 = (await http.get(`/api/events/${ev.eventId}/waitlist`, { token: (w2 as TestUser).token })).json as { offer: { seatId: number } | null };
    expect(s2.offer?.seatId).toBe(ev.seatIds[0]);
    expect((await http.get(`/api/events/${ev.eventId}/waitlist`, { token: (w3 as TestUser).token })).json).toMatchObject({ offer: null });
    expect((await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[0]] }, { token: (rival as TestUser).token, headers: { 'idempotency-key': idem() } })).status).toBe(409);

    // w2 takes it through the normal hold and payment
    const order = await holdSeats(http, ev.eventId, w2 as TestUser, [ev.seatIds[0] as number]);
    await payFully(api, http, w2 as TestUser, order.id);
    expect((await q(`SELECT status::text AS s FROM waitlist_entries WHERE event_id = $1 AND user_id = $2`, [ev.eventId, (w2 as TestUser).id]))[0]?.['s']).toBe('fulfilled');
    expect((await q(`SELECT status::text AS s FROM waitlist_offers WHERE event_id = $1 AND user_id = $2`, [ev.eventId, (w2 as TestUser).id]))[0]?.['s']).toBe('used');
    await drainTasks(tdb.pool, providerOf(api));
    await setClock(http, 0);
  });

  it('leaving the waitlist while holding an offer passes the seat on at once', async () => {
    const api = await bootLoop(tdb);
    closers.push(api.close);
    const http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.151' });
    bindPool(api, tdb.pool);
    const organizer = await createUser(tdb.pool, api.env, 'organizer');
    const ev = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 2 });
    const owners = await createUsers(tdb.pool, api.env, 2);
    const orders = [];
    for (const [i, o] of owners.entries()) {
      const order = await holdSeats(http, ev.eventId, o, [ev.seatIds[i] as number]);
      await payFully(api, http, o, order.id);
      orders.push(order);
    }
    const [a, b] = await createUsers(tdb.pool, api.env, 2);
    await http.post(`/api/events/${ev.eventId}/waitlist`, {}, { token: (a as TestUser).token });
    await http.post(`/api/events/${ev.eventId}/waitlist`, {}, { token: (b as TestUser).token });
    await http.post(`/api/orders/${orders[0]?.id}/refund`, {}, { token: (owners[0] as TestUser).token, headers: { 'idempotency-key': idem() } });
    expect(((await http.get(`/api/events/${ev.eventId}/waitlist`, { token: (a as TestUser).token })).json as { offer: unknown }).offer).not.toBeNull();
    await http.delete(`/api/events/${ev.eventId}/waitlist`, { token: (a as TestUser).token });
    expect(((await http.get(`/api/events/${ev.eventId}/waitlist`, { token: (b as TestUser).token })).json as { offer: unknown }).offer).not.toBeNull();
    expect((await q(`SELECT COUNT(*)::int AS n FROM waitlist_offers WHERE event_id = $1 AND status = 'active'`, [ev.eventId]))[0]?.['n']).toBe(1);
    await drainTasks(tdb.pool, providerOf(api));
  });
});

describe('virtual queue through the API', () => {
  it('limit 1: the second buyer waits, cannot hold seats, and is let in after the first has paid', async () => {
    const api = await bootLoop(tdb, { QUEUE_ACTIVATE_AT: '0', QUEUE_MAX_SELECTING: '1' });
    closers.push(api.close);
    bindPool(api, tdb.pool);
    const http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.152' });
    const organizer = await createUser(tdb.pool, api.env, 'organizer');
    const ev = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 10 });
    const [a, b] = await createUsers(tdb.pool, api.env, 2);
    const join = (u: TestUser) => http.post(`/api/events/${ev.eventId}/queue`, {}, { token: u.token });
    expect((await join(a as TestUser)).json).toMatchObject({ status: 'admitted', queueActive: true });
    const bView = (await join(b as TestUser)).json as { status: string; position: number; etaSeconds: number };
    expect(bView).toMatchObject({ status: 'waiting', position: 1 });
    expect(bView.etaSeconds).toBeGreaterThanOrEqual(0);
    const refused = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[0]] }, { token: (b as TestUser).token, headers: { 'idempotency-key': idem() } });
    expect(refused.json).toMatchObject({ error: { code: 'QUEUE_REQUIRED' } });
    const order = await holdSeats(http, ev.eventId, a as TestUser, [ev.seatIds[1] as number]);
    expect(((await http.get(`/api/events/${ev.eventId}/queue`, { token: (a as TestUser).token })).json as { status: string }).status).toBe('selecting');
    expect(((await http.get(`/api/events/${ev.eventId}/queue`, { token: (b as TestUser).token })).json as { status: string }).status).toBe('waiting');
    await payFully(api, http, a as TestUser, order.id);
    await waitFor(async () => ((await http.get(`/api/events/${ev.eventId}/queue`, { token: (b as TestUser).token })).json as { status: string }).status === 'admitted');
    expect((await holdSeats(http, ev.eventId, b as TestUser, [ev.seatIds[2] as number])).items).toHaveLength(1);
    const funnel = ((await http.get('/api/organizer/reports/sales', { token: organizer.token })).json as { funnel: { joinedQueue: number; admitted: number; paid: number } }).funnel;
    expect(funnel).toMatchObject({ joinedQueue: 2, admitted: 2, paid: 1 });
  });

  it('reloads and second tabs never create a second place; others cannot see your place; anonymous is refused', async () => {
    const api = await bootApi(tdb, { QUEUE_ACTIVATE_AT: '0', QUEUE_MAX_SELECTING: '1' });
    closers.push(api.close);
    const http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.153' });
    const organizer = await createUser(tdb.pool, api.env, 'organizer');
    const ev = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 5 });
    const [first, me, other] = await createUsers(tdb.pool, api.env, 3);
    await http.post(`/api/events/${ev.eventId}/queue`, {}, { token: (first as TestUser).token });
    const tabs = await Promise.all(Array.from({ length: 25 }, () => http.post(`/api/events/${ev.eventId}/queue`, {}, { token: (me as TestUser).token })));
    expect(new Set(tabs.map((t) => (t.json as { position: number }).position))).toEqual(new Set([1]));
    expect((await q(`SELECT COUNT(*)::int AS n FROM queue_entries WHERE event_id = $1 AND user_id = $2`, [ev.eventId, (me as TestUser).id]))[0]?.['n']).toBe(1);
    expect((await http.get(`/api/events/${ev.eventId}/queue`, { token: (other as TestUser).token })).status).toBe(404);
    expect((await http.post(`/api/events/${ev.eventId}/queue`, {})).status).toBe(401);
    expect((await http.post(`/api/events/${crypto.randomUUID()}/queue`, {}, { token: (me as TestUser).token })).status).toBe(404);
  });

  it('300 simultaneous joiners across both api copies: never more than the capacity admitted, strict order', async () => {
    const a = await bootApi(tdb, { QUEUE_ACTIVATE_AT: '0', QUEUE_MAX_SELECTING: '20' });
    const b = await bootApi(tdb, { QUEUE_ACTIVATE_AT: '0', QUEUE_MAX_SELECTING: '20', API_INSTANCE_ID: 'api-2' });
    closers.push(a.close, b.close);
    const ca = client({ baseUrl: a.baseUrl, sourceIp: '127.0.0.154' });
    const cb = client({ baseUrl: b.baseUrl, sourceIp: '127.0.0.155' });
    const organizer = await createUser(tdb.pool, a.env, 'organizer');
    const ev = await createOnSaleEvent(ca, tdb.pool, organizer, { seats: 10 });
    const crowd = await createUsers(tdb.pool, a.env, 300);
    const replies = await Promise.all(crowd.map((u, i) => (i % 2 ? cb : ca).post(`/api/events/${ev.eventId}/queue`, {}, { token: u.token })));
    expect(replies.every((r) => r.status === 200)).toBe(true);
    const counts = Object.fromEntries((await q(`SELECT status::text AS s, COUNT(*)::int AS n FROM queue_entries WHERE event_id = $1 GROUP BY 1`, [ev.eventId])).map((r) => [r['s'], r['n']]));
    expect(counts).toEqual({ admitted: 20, waiting: 280 });
    const order = await q(`SELECT status::text AS s FROM queue_entries WHERE event_id = $1 ORDER BY seq`, [ev.eventId]);
    expect(order.slice(0, 20).every((r) => r['s'] === 'admitted')).toBe(true);
    const polled = await Promise.all(crowd.slice(0, 40).map((u, i) => (i % 2 ? cb : ca).get(`/api/events/${ev.eventId}/queue`, { token: u.token })));
    expect(polled.every((r) => r.status === 200)).toBe(true);
    expect((await q(`SELECT COUNT(*)::int AS n FROM queue_entries WHERE event_id = $1 AND status IN ('admitted', 'selecting')`, [ev.eventId]))[0]?.['n']).toBe(20);
    const positions = await Promise.all(crowd.map((u, i) => (i % 2 ? cb : ca).get(`/api/events/${ev.eventId}/queue`, { token: u.token })));
    const waitingPositions = positions.map((r) => (r.json as { position: number | null }).position).filter((p): p is number => p !== null).sort((x, y) => x - y);
    expect(waitingPositions).toEqual(Array.from({ length: 280 }, (_, i) => i + 1));
    expect(statusCounts(positions)).toEqual({ 200: 300 });
  });

  it('with the real thresholds, 300 buyers who skip the join button and just hold seats still switch the queue on and are capped at 200', async () => {
    const a = await bootApi(tdb); // QUEUE_ACTIVATE_AT=500, QUEUE_MAX_SELECTING=200
    const b = await bootApi(tdb, { API_INSTANCE_ID: 'api-2' });
    closers.push(a.close, b.close);
    const ca = client({ baseUrl: a.baseUrl, sourceIp: '127.0.0.156' });
    const cb = client({ baseUrl: b.baseUrl, sourceIp: '127.0.0.157' });
    const organizer = await createUser(tdb.pool, a.env, 'organizer');
    const ev = await createOnSaleEvent(ca, tdb.pool, organizer, { seats: 300 });
    const crowd = await createUsers(tdb.pool, a.env, 300);
    const replies = await Promise.all(crowd.map((u, i) => (i % 2 ? cb : ca).post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[i]] }, { token: u.token, headers: { 'idempotency-key': idem() } })));
    const codes = replies.map((r) => (r.status === 200 ? 'held' : (r.json as { error: { code: string } }).error.code));
    expect(codes.filter((c) => c === 'held')).toHaveLength(200);
    expect(codes.filter((c) => c === 'QUEUE_REQUIRED')).toHaveLength(100);
    expect((await q(`SELECT queue_active FROM events WHERE id = $1`, [ev.eventId]))[0]).toMatchObject({ queue_active: true });
    expect((await q(`SELECT COUNT(*)::int AS n FROM queue_entries WHERE event_id = $1 AND status IN ('admitted', 'selecting')`, [ev.eventId]))[0]?.['n']).toBe(200);
    expect((await q(`SELECT COUNT(*)::int AS n FROM orders WHERE event_id = $1 AND status = 'holding'`, [ev.eventId]))[0]?.['n']).toBe(200);
  });

  it('a hold attempted before the sale opens is refused and leaves no queue entry behind', async () => {
    const a = await bootApi(tdb);
    closers.push(a.close);
    const ca = client({ baseUrl: a.baseUrl, sourceIp: '127.0.0.158' });
    const organizer = await createUser(tdb.pool, a.env, 'organizer');
    const ev = await createOnSaleEvent(ca, tdb.pool, organizer, { seats: 5 });
    await tdb.pool.query(`UPDATE events SET sales_start_at = now() + interval '1 day' WHERE id = $1`, [ev.eventId]);
    const early = await createUsers(tdb.pool, a.env, 3);
    for (const u of early) {
      const r = await ca.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[0]] }, { token: u.token, headers: { 'idempotency-key': idem() } });
      expect(r.json).toMatchObject({ error: { code: 'EVENT_NOT_ON_SALE' } });
    }
    expect((await q(`SELECT COUNT(*)::int AS n FROM queue_entries WHERE event_id = $1`, [ev.eventId]))[0]?.['n']).toBe(0);
  });
});
