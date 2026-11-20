import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, createTestRedis, waitFor, type TestDb } from '@ticketing/testkit';
import { client, type Client } from '../attacker/index.js';
import { bootApi, type BootedApi } from '../helpers/boot.js';
import { createOnSaleEvent, idem, type ApiEvent } from '../helpers/event-fixture.js';
import { createUser, createUsers, type TestUser } from '../helpers/session.js';

interface Change { seq: number; seatId: number | null; zoneId: string | null; status: string; heldUntil: number | null; available: number | null }
interface Ack { ok: boolean; code?: string; seq?: number; serverTime?: string; resync?: boolean; changes?: Change[] }

let tdb: TestDb;
let a: BootedApi;
let b: BootedApi;
let ca: Client;
let organizer: TestUser;
let ev: ApiEvent;
const sockets: Socket[] = [];

const connect = (api: BootedApi, token: string | undefined): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = io(api.baseUrl, { auth: token === undefined ? {} : { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
  });
const subscribe = (s: Socket, body: unknown): Promise<Ack> => new Promise((resolve) => s.timeout(5_000).emit('subscribe', body, (err: Error | null, ack: Ack) => resolve(err ? { ok: false, code: 'TIMEOUT' } : ack)));
const collect = (s: Socket, event: string): Change[][] => {
  const batches: Change[][] = [];
  s.on(event, (m: { changes: Change[] }) => batches.push(m.changes));
  return batches;
};

beforeAll(async () => {
  tdb = await createTestDb();
  a = await bootApi(tdb);
  b = await bootApi(tdb, { API_INSTANCE_ID: 'api-2' });
  ca = client({ baseUrl: a.baseUrl, sourceIp: '127.0.0.170' });
  organizer = await createUser(tdb.pool, a.env, 'organizer');
  ev = await createOnSaleEvent(ca, tdb.pool, organizer, { seats: 30, floor: 5 });
});
afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await Promise.all([a.close(), b.close()]);
  await tdb.drop();
});

const hold = (c: Client, user: TestUser, seatIds: number[], eventId = ev.eventId) =>
  c.post(`/api/events/${eventId}/holds`, { seatIds }, { token: user.token, headers: { 'idempotency-key': idem() } });

describe('logging out closes open sockets', () => {
  it('a socket connected to the other api copy is disconnected when the session is logged out, and others stay connected', async () => {
    const make = async () => {
      const r = await ca.post('/api/auth/register', { email: `ws-${crypto.randomUUID()}@example.test`, password: 'Correct-horse-battery-1', displayName: 'WS' });
      expect(r.status).toBe(201);
      return r.json as { accessToken: string; refreshToken: string };
    };
    const [leaving, staying] = [await make(), await make()];
    const onB = await connect(b, leaving.accessToken);
    const other = await connect(b, staying.accessToken);
    const closed = new Promise<string>((resolve) => onB.on('disconnect', (reason) => resolve(reason)));
    expect((await ca.post('/api/auth/logout', { refreshToken: leaving.refreshToken })).status).toBe(204);
    expect(await closed).toBe('io server disconnect');
    expect(other.connected).toBe(true);
  });
});

describe('live seat updates across both api copies (acceptance 3)', () => {
  it('a seat held through copy A reaches a viewer connected to copy B in under a second, and release/sale follow', async () => {
    const [watcher, buyer] = await createUsers(tdb.pool, a.env, 2);
    const onB = await connect(b, (watcher as TestUser).token);
    const onA = await connect(a, (watcher as TestUser).token);
    const seenB = collect(onB, 'seat.changes');
    const seenA = collect(onA, 'seat.changes');
    expect((await subscribe(onB, { eventId: ev.eventId })).ok).toBe(true);
    expect((await subscribe(onA, { eventId: ev.eventId })).ok).toBe(true);
    const started = Date.now();
    const held = await hold(ca, buyer as TestUser, [ev.seatIds[0] as number]);
    expect(held.status).toBe(200);
    await waitFor(() => seenB.flat().some((c) => c.seatId === ev.seatIds[0] && c.status === 'held'), 2_000, 10);
    const latency = Date.now() - started;
    expect(latency).toBeLessThan(1_000);
    await waitFor(() => seenA.flat().some((c) => c.seatId === ev.seatIds[0] && c.status === 'held'), 2_000, 10);
    const change = seenB.flat().find((c) => c.seatId === ev.seatIds[0]);
    expect(change?.heldUntil).toBeGreaterThan(Date.now());
    const orderId = (held.json as { id: string }).id;
    await ca.post(`/api/orders/${orderId}/release`, {}, { token: (buyer as TestUser).token });
    await waitFor(() => seenB.flat().some((c) => c.seatId === ev.seatIds[0] && c.status === 'free'), 2_000, 10);
    const seqs = seenB.flat().map((c) => c.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs.filter((s, i) => seqs.indexOf(s) === i).sort((x, y) => x - y).length === seqs.length ? seqs : [...seqs].sort((x, y) => x - y)); // ordered by sequence
  });

  it('keeps working after Redis loses all its data', async () => {
    const [watcher, buyer] = await createUsers(tdb.pool, a.env, 2);
    const onB = await connect(b, (watcher as TestUser).token);
    const seen = collect(onB, 'seat.changes');
    await subscribe(onB, { eventId: ev.eventId });
    const tr = createTestRedis();
    await tr.redis.flushall();
    await tr.close();
    await hold(ca, buyer as TestUser, [ev.seatIds[3] as number]);
    await waitFor(() => seen.flat().some((c) => c.seatId === ev.seatIds[3] && c.status === 'held'), 4_000, 25);
  });

  it('a reconnecting client catches up from its last sequence number, in order, without duplicates it already has', async () => {
    const [w, buyer] = await createUsers(tdb.pool, a.env, 2);
    const first = await connect(b, (w as TestUser).token);
    const baseline = await subscribe(first, { eventId: ev.eventId });
    first.disconnect();
    for (const i of [5, 6, 7]) await hold(ca, buyer as TestUser, [ev.seatIds[i] as number]);
    const second = await connect(b, (w as TestUser).token);
    const ack = await subscribe(second, { eventId: ev.eventId, lastSeq: baseline.seq });
    expect(ack.resync).toBeUndefined();
    const seqs = (ack.changes ?? []).map((c) => c.seq);
    expect(seqs.length).toBeGreaterThanOrEqual(3);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(Math.min(...seqs)).toBeGreaterThan(baseline.seq ?? 0);
    expect((ack.changes ?? []).filter((c) => c.status === 'held').map((c) => c.seatId)).toEqual(expect.arrayContaining([5, 6, 7].map((i) => ev.seatIds[i])));
    expect(ack.seq).toBeGreaterThanOrEqual(Math.max(...seqs));
    await tdb.pool.query(`UPDATE events SET seat_seq = seat_seq + 6000 WHERE id = $1`, [ev.eventId]);
    const far = await subscribe(second, { eventId: ev.eventId, lastSeq: baseline.seq });
    expect(far).toMatchObject({ ok: true, resync: true, changes: [] }); // too far behind: refetch the whole map instead
    await tdb.pool.query(`UPDATE events SET seat_seq = seat_seq - 6000 WHERE id = $1`, [ev.eventId]);
  });
});

describe('authentication and room isolation (acceptance 17)', () => {
  it('connections without a valid token are rejected', async () => {
    const [user] = await createUsers(tdb.pool, a.env, 1);
    await expect(connect(a, undefined)).rejects.toThrow(/unauthorized/);
    await expect(connect(a, 'garbage')).rejects.toThrow(/unauthorized/);
    await expect(connect(a, `${(user as TestUser).token}x`)).rejects.toThrow(/unauthorized/);
    await tdb.pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1`, [(user as TestUser).familyId]);
    await expect(connect(a, (user as TestUser).token)).rejects.toThrow(/unauthorized/); // logged out
  });

  it('personal notifications reach only the addressee', async () => {
    const queued = await bootApi(tdb, { QUEUE_ACTIVATE_AT: '0', QUEUE_MAX_SELECTING: '5' });
    try {
      const c = client({ baseUrl: queued.baseUrl, sourceIp: '127.0.0.171' });
      const evq = await createOnSaleEvent(c, tdb.pool, organizer, { seats: 5 });
      const [x, y] = await createUsers(tdb.pool, queued.env, 2);
      const sx = await connect(queued, (x as TestUser).token);
      const sy = await connect(queued, (y as TestUser).token);
      const gotX: unknown[] = [];
      const gotY: unknown[] = [];
      sx.on('queue.update', (m) => gotX.push(m));
      sy.on('queue.update', (m) => gotY.push(m));
      await c.post(`/api/events/${evq.eventId}/queue`, {}, { token: (x as TestUser).token });
      await waitFor(() => gotX.length > 0, 3_000, 20);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(gotX[0]).toMatchObject({ eventId: evq.eventId, status: 'admitted' });
      expect(gotY).toEqual([]);
    } finally {
      await queued.close();
    }
  });

  it('a client cannot subscribe to drafts, foreign admin rooms or invented rooms', async () => {
    const [user] = await createUsers(tdb.pool, a.env, 1);
    const stranger = await createUser(tdb.pool, a.env, 'organizer');
    const s = await connect(a, (user as TestUser).token);
    const draft = await ca.post('/api/organizer/events', {
      venueId: ev.venueId, title: 'Hidden draft', category: 'x', startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), salesStartAt: new Date().toISOString(),
      pricing: { tiers: [{ name: 'T', price: 1_000 }], assignments: [{ tierIndex: 0, zoneIds: [ev.seatedZoneId, ev.floorZoneId] }] },
    }, { token: organizer.token });
    const draftId = (draft.json as { id: string }).id;
    expect(await subscribe(s, { eventId: draftId })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await subscribe(s, { eventId: ev.eventId, admin: true })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const so = await connect(a, stranger.token);
    expect(await subscribe(so, { eventId: ev.eventId, admin: true })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await subscribe(s, { eventId: 'user:someone-else' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(await subscribe(s, { eventId: ev.eventId, extra: 1 })).toMatchObject({ ok: false });
    const owner = await connect(a, organizer.token);
    expect(await subscribe(owner, { eventId: draftId })).toMatchObject({ ok: true });
    expect(await subscribe(owner, { eventId: ev.eventId, admin: true })).toMatchObject({ ok: true });
    const leaked: unknown[] = [];
    s.onAny((name: string, m: unknown) => leaked.push([name, m]));
    owner.emit('noop');
    const buyer = await createUser(tdb.pool, a.env);
    await hold(ca, buyer, [ev.seatIds[20] as number]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(leaked).toEqual([]); // `s` never subscribed to the event, so it hears nothing
  });

  it('only the organizer of an event hears its admin channel', async () => {
    const owner = await connect(a, organizer.token);
    const other = await createUser(tdb.pool, a.env, 'organizer');
    const stranger = await connect(a, other.token);
    await subscribe(owner, { eventId: ev.eventId, admin: true });
    await subscribe(stranger, { eventId: ev.eventId });
    const heard: string[] = [];
    owner.on('event.updated', () => heard.push('owner'));
    stranger.on('event.updated', () => heard.push('stranger'));
    const when = new Date(Date.now() + 40 * 86_400_000).toISOString();
    expect((await ca.post(`/api/organizer/events/${ev.eventId}/reschedule`, { startsAt: when }, { token: organizer.token })).status).toBe(200);
    await waitFor(() => heard.includes('owner'), 3_000, 20);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(heard).toEqual(['owner']);
  });
});

describe('abuse', () => {
  it('a socket that floods messages is throttled and disconnected, others are unaffected', async () => {
    const [noisy, calm] = await createUsers(tdb.pool, a.env, 2);
    const bad = await connect(a, (noisy as TestUser).token);
    const good = await connect(a, (calm as TestUser).token);
    let disconnected = false;
    bad.on('disconnect', () => {
      disconnected = true;
    });
    for (let i = 0; i < 200; i += 1) bad.emit('subscribe', { eventId: ev.eventId });
    await waitFor(() => disconnected, 5_000, 20);
    expect((await subscribe(good, { eventId: ev.eventId })).ok).toBe(true);
  });
});
