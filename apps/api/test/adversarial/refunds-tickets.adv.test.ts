import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, expectLedgerClean, type TestDb } from '@ticketing/testkit';
import { client, statusCounts, type Client } from '../attacker/index.js';
import { type BootedApi } from '../helpers/boot.js';
import { createOnSaleEvent, idem, type ApiEvent } from '../helpers/event-fixture.js';
import { bootLoop } from '../helpers/full-stack.js';
import { bindPool, drainTasks, holdSeats, payFully, providerOf, setClock } from '../helpers/flow.js';
import { createUser, createUsers, type TestUser } from '../helpers/session.js';

const DAY = 86_400_000;
let tdb: TestDb;
let api: BootedApi;
let http: Client;
let organizer: TestUser;
let finance: TestUser;
let scanner: TestUser;
let ev: ApiEvent;
let next = 0;

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootLoop(tdb);
  bindPool(api, tdb.pool);
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.140' });
  organizer = await createUser(tdb.pool, api.env, 'organizer');
  finance = await createUser(tdb.pool, api.env, 'finance');
  scanner = await createUser(tdb.pool, api.env, 'scanner');
  ev = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 80 });
  await tdb.pool.query(`INSERT INTO event_staff (event_id, user_id) VALUES ($1, $2)`, [ev.eventId, scanner.id]);
});
afterAll(async () => {
  await api.close();
  await tdb.drop();
});

const seats = (n: number): number[] => Array.from({ length: n }, () => ev.seatIds[next++] as number);
const q = async (sql: string, params: unknown[] = []) => (await tdb.pool.query(sql, params)).rows as Record<string, unknown>[];

const buy = async (user: TestUser, n: number) => {
  const order = await holdSeats(http, ev.eventId, user, seats(n));
  await payFully(api, http, user, order.id);
  return order;
};
const myTickets = async (user: TestUser) => ((await http.get('/api/tickets', { token: user.token })).json as { items: { id: string; orderId: string; code: string; status: string }[] }).items;
const refund = (user: TestUser, orderId: string, itemIds?: string[], key = idem()) => http.post(`/api/orders/${orderId}/refund`, itemIds ? { itemIds } : {}, { token: user.token, headers: { 'idempotency-key': key } });
const worker = () => drainTasks(tdb.pool, providerOf(api));

describe('refund rules by time to the event', () => {
  it('more than 7 days: the price without the service fee; the ticket dies at once and the seat is free again', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 2);
    const quote = (await http.get(`/api/orders/${order.id}/refund-quote`, { token: buyer.token })).json as { items: { refundable: boolean; kind: string; price: number; fee: number }[]; total: number };
    expect(quote.items).toMatchObject([{ refundable: true, kind: 'full', price: 100_000, fee: 0 }, { refundable: true, kind: 'full', price: 100_000, fee: 0 }]);
    const [first] = order.items;
    const r = await refund(buyer, order.id, [first?.id ?? '']);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: 'user', status: 'requested', amount: 100_000, feeAmount: 0 });
    expect((await myTickets(buyer)).filter((t) => t.orderId === order.id).map((t) => t.status).sort()).toEqual(['refunded', 'valid']);
    expect(await q(`SELECT status::text AS s FROM orders WHERE id = $1`, [order.id])).toEqual([{ s: 'partially_refunded' }]);
    const seat = await q(`SELECT status::text AS s FROM event_seats WHERE event_id = $1 AND seat_id = $2`, [ev.eventId, first?.seatId]);
    expect(seat).toEqual([{ s: 'free' }]);
    await worker();
    expect(await q(`SELECT status::text AS s FROM refunds WHERE id = $1`, [(r.json as { id: string }).id])).toEqual([{ s: 'succeeded' }]);
    await expectLedgerClean(tdb.pool);
  });

  it('2 to 7 days: 50% of the price; less than 2 days: refused with a reason', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 2);
    await setClock(http, 25 * DAY + 1_000); // 5 days before the start
    const half = await refund(buyer, order.id, [order.items[0]?.id ?? '']);
    expect(half.json).toMatchObject({ amount: 50_000, priceAmount: 50_000, feeAmount: 0 });
    await setClock(http, 29 * DAY); // 1 day before the start
    const late = await refund(buyer, order.id, [order.items[1]?.id ?? '']);
    expect(late.status).toBe(422);
    expect(late.json).toMatchObject({ error: { code: 'REFUND_NOT_ALLOWED', details: { reason: 'event_started_or_too_late' } } });
    await setClock(http, 0);
    await worker();
    await expectLedgerClean(tdb.pool);
  });

  it('rescheduled events can be refunded in full for 14 days, whatever the lead time', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 1);
    const target = new Date(Date.now() + 1.5 * DAY).toISOString(); // would normally be too late to refund
    expect((await http.post(`/api/organizer/events/${ev.eventId}/reschedule`, { startsAt: target }, { token: organizer.token })).status).toBe(200);
    const r = await refund(buyer, order.id);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ priceAmount: 100_000, feeAmount: 0 });
    expect((await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE dedupe_key LIKE 'email:resched:%'`))[0]?.['n']).toBeGreaterThan(0);
    await tdb.pool.query(`UPDATE events SET starts_at = app_now() + interval '30 days', rescheduled_at = NULL WHERE id = $1`, [ev.eventId]); // back to the normal schedule for the other tests
    await worker();
  });
});

describe('refunds under concurrency (acceptance 9)', () => {
  it('10 parallel refund requests for one order: one wins, the rest are refused, never more than was paid', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 2);
    const replies = await Promise.all(Array.from({ length: 10 }, () => refund(buyer, order.id)));
    expect(statusCounts(replies)).toEqual({ 200: 1, 422: 9 });
    const sum = await q(`SELECT COALESCE(SUM(ri.price_amount + ri.fee_amount), 0)::int AS n FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE r.order_id = $1 AND ri.active`, [order.id]);
    expect(sum[0]?.['n']).toBe(200_000);
    expect(sum[0]?.['n'] as number).toBeLessThanOrEqual(order.total);
    await worker();
    await expectLedgerClean(tdb.pool);
  });

  it('per-ticket requests: each ticket is refunded exactly once however many callers race for it', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 2);
    const [a, b] = order.items.map((i) => i.id);
    const replies = await Promise.all([...Array.from({ length: 6 }, () => refund(buyer, order.id, [a ?? ''])), ...Array.from({ length: 6 }, () => refund(buyer, order.id, [b ?? '']))]);
    expect(statusCounts(replies)).toEqual({ 200: 2, 422: 10 });
    expect((await q(`SELECT COUNT(*)::int AS n FROM refunds WHERE order_id = $1`, [order.id]))[0]?.['n']).toBe(2);
    expect(await q(`SELECT status::text AS s FROM orders WHERE id = $1`, [order.id])).toEqual([{ s: 'refunded' }]);
  });

  it('a user refund racing a finance refund of the same order cannot refund twice', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 1);
    const replies = await Promise.all([
      refund(buyer, order.id),
      http.post(`/api/finance/orders/${order.id}/refund`, { reason: 'duplicate charge complaint' }, { token: finance.token, headers: { 'idempotency-key': idem() } }),
      refund(buyer, order.id),
      http.post(`/api/finance/orders/${order.id}/refund`, { reason: 'duplicate charge complaint' }, { token: finance.token, headers: { 'idempotency-key': idem() } }),
    ]);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await q(`SELECT COUNT(*)::int AS n FROM refunds WHERE order_id = $1`, [order.id]))[0]?.['n']).toBe(1);
  });

  it('the same Idempotency-Key repeated gives one refund and the same answer', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 1);
    const key = idem();
    const replies = await Promise.all(Array.from({ length: 8 }, () => refund(buyer, order.id, undefined, key)));
    expect(statusCounts(replies)).toEqual({ 200: 8 });
    expect(new Set(replies.map((r) => (r.json as { id: string }).id)).size).toBe(1);
    expect((await q(`SELECT COUNT(*)::int AS n FROM refunds WHERE order_id = $1`, [order.id]))[0]?.['n']).toBe(1);
  });

  it('two workers executing the same refund at once: the provider refunds once and the ledger posts once', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 1);
    const r = (await refund(buyer, order.id)).json as { id: string };
    await Promise.all([worker(), worker(), worker()]);
    await worker();
    expect(await q(`SELECT status::text AS s FROM refunds WHERE id = $1`, [r.id])).toEqual([{ s: 'succeeded' }]);
    expect((await q(`SELECT COUNT(*)::int AS n FROM stub_refunds WHERE reference = $1`, [r.id]))[0]?.['n']).toBe(1);
    expect((await q(`SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = 'refund' AND ref_id = $1`, [r.id]))[0]?.['n']).toBe(1);
    await expectLedgerClean(tdb.pool);
  });

  it('only the owner of the order can refund; finance needs a reason and the finance role', async () => {
    const [owner, stranger] = await createUsers(tdb.pool, api.env, 2);
    const order = await buy(owner as TestUser, 1);
    expect((await refund(stranger as TestUser, order.id)).status).toBe(404);
    expect((await http.post(`/api/finance/orders/${order.id}/refund`, { reason: 'x' }, { token: finance.token, headers: { 'idempotency-key': idem() } })).status).toBe(400);
    expect((await http.post(`/api/finance/orders/${order.id}/refund`, { reason: 'no way' }, { token: (owner as TestUser).token, headers: { 'idempotency-key': idem() } })).status).toBe(403);
    const manual = await http.post(`/api/finance/orders/${order.id}/refund`, { reason: 'Customer called, event moved' }, { token: finance.token, headers: { 'idempotency-key': idem() } });
    expect(manual.json).toMatchObject({ kind: 'finance', amount: 105_000, reason: 'Customer called, event moved' }); // price and fee, whatever the policy says
    const history = (await http.get(`/api/orders/${order.id}/history`, { token: (owner as TestUser).token })).json as { items: { type: string; actorRole: string }[] };
    expect(history.items.find((h) => h.type === 'refund_requested')).toMatchObject({ actorRole: 'finance' });
  });
});

describe('refunding by ticket, including transferred tickets', () => {
  const ticketRefund = (user: TestUser, ticketId: string, key = idem()) => http.post(`/api/tickets/${ticketId}/refund`, undefined, { token: user.token, headers: { 'idempotency-key': key } });
  const emailOf = async (u: TestUser) => ((await tdb.pool.query(`SELECT email FROM users WHERE id = $1`, [u.id])).rows[0] as { email: string }).email;

  it('the recipient of a transferred ticket can return it; the money goes back to the original payment; the giver cannot revoke it', async () => {
    const [alice, bob, eve] = (await createUsers(tdb.pool, api.env, 3)) as [TestUser, TestUser, TestUser];
    const order = await buy(alice, 2);
    const [given, kept] = (await myTickets(alice)).filter((t) => t.orderId === order.id);
    expect((await http.post(`/api/tickets/${given?.id}/transfer`, { email: await emailOf(bob) }, { token: alice.token, headers: { 'idempotency-key': idem() } })).status).toBe(200);
    const givenItem = (await q(`SELECT order_item_id AS i FROM tickets WHERE id = $1`, [given?.id]))[0]?.['i'] as string;

    // the giver: neither the order refund nor the ticket refund can take it back
    expect((await refund(alice, order.id, [givenItem])).json).toMatchObject({ error: { code: 'REFUND_NOT_ALLOWED', details: { reason: 'transferred' } } });
    expect((await ticketRefund(alice, given?.id ?? '')).status).toBe(404);
    expect((await ticketRefund(eve, given?.id ?? '')).status).toBe(404); // and nobody else either

    // the holder
    const quote = await http.get(`/api/tickets/${given?.id}/refund-quote`, { token: bob.token });
    expect(quote.json).toMatchObject({ orderId: order.id, items: [{ itemId: givenItem, refundable: true, price: 100_000, fee: 0 }], total: 100_000 });
    const key = idem();
    const done = await ticketRefund(bob, given?.id ?? '', key);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ orderId: order.id, kind: 'user', amount: 100_000 });
    expect((await ticketRefund(bob, given?.id ?? '', key)).json).toEqual(done.json); // a retry is the same refund
    expect((await ticketRefund(bob, given?.id ?? '')).json).toMatchObject({ error: { code: 'REFUND_NOT_ALLOWED' } }); // a second refund is not
    expect(await q(`SELECT ri.order_item_id AS i FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE r.order_id = $1`, [order.id])).toEqual([{ i: givenItem }]);

    await worker();
    expect(await q(`SELECT status::text AS s FROM refunds WHERE order_id = $1`, [order.id])).toEqual([{ s: 'succeeded' }]);
    expect((await myTickets(bob)).find((t) => t.id === given?.id)?.status).toBe('refunded');
    expect((await myTickets(alice)).find((t) => t.id === kept?.id)?.status).toBe('valid');
    expect(await q(`SELECT status::text AS s FROM orders WHERE id = $1`, [order.id])).toEqual([{ s: 'partially_refunded' }]);
    await expectLedgerClean(tdb.pool);
  });

  it('refunding one ticket of a multi-ticket order returns exactly that ticket', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 3);
    const tickets = (await myTickets(buyer)).filter((t) => t.orderId === order.id);
    const last = tickets[2];
    expect((await ticketRefund(buyer, last?.id ?? '')).status).toBe(200);
    const after = (await myTickets(buyer)).filter((t) => t.orderId === order.id);
    expect(after.filter((t) => t.status === 'refunded').map((t) => t.id)).toEqual([last?.id]);
  });
});

describe('a refund the payment provider rejects', () => {
  it('stays visible as owed money: the order says failed, the ticket cannot be refunded twice, finance retries until it goes through once', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 2);
    const [ticket] = (await myTickets(buyer)).filter((t) => t.orderId === order.id);
    const providerPayment = (await q(`SELECT provider_payment_id AS p FROM payments WHERE order_id = $1 AND status = 'succeeded'`, [order.id]))[0]?.['p'];
    await q(`UPDATE stub_payments SET status = 'failed' WHERE id = $1`, [providerPayment]); // the provider will refuse any refund of it
    const orderView = async () => (await http.get(`/api/orders/${order.id}`, { token: buyer.token })).json as { status: string; refundState: string };

    const asked = await http.post(`/api/tickets/${ticket?.id}/refund`, undefined, { token: buyer.token, headers: { 'idempotency-key': idem() } });
    expect(asked.status).toBe(200);
    const refundId = (asked.json as { id: string }).id;
    expect(await orderView()).toMatchObject({ status: 'partially_refunded', refundState: 'in_progress' });
    await worker();
    expect(await q(`SELECT status::text AS s, provider_attempt AS a FROM refunds WHERE id = $1`, [refundId])).toEqual([{ s: 'failed', a: 0 }]);
    expect(await orderView()).toMatchObject({ refundState: 'failed' }); // never shown as done
    expect((await http.post(`/api/tickets/${ticket?.id}/refund`, undefined, { token: buyer.token, headers: { 'idempotency-key': idem() } })).json).toMatchObject({ error: { code: 'REFUND_NOT_ALLOWED' } });
    expect((await http.get('/api/finance/refunds/failed', { token: buyer.token })).status).toBe(403);
    const listed = (await http.get('/api/finance/refunds/failed', { token: finance.token })).json as { items: { id: string; attempt: number }[] };
    expect(listed.items).toContainEqual(expect.objectContaining({ id: refundId, attempt: 0 }));

    // still rejected: a retry is a new attempt and fails again, visibly
    expect((await http.post(`/api/finance/refunds/${refundId}/retry`, undefined, { token: buyer.token })).status).toBe(403);
    expect((await http.post(`/api/finance/refunds/${refundId}/retry`, undefined, { token: finance.token })).json).toMatchObject({ id: refundId, status: 'requested' });
    await worker();
    expect(await q(`SELECT status::text AS s, provider_attempt AS a FROM refunds WHERE id = $1`, [refundId])).toEqual([{ s: 'failed', a: 1 }]);

    // the provider accepts now
    await q(`UPDATE stub_payments SET status = 'succeeded' WHERE id = $1`, [providerPayment]);
    const [r1, r2] = await Promise.all([1, 2].map(() => http.post(`/api/finance/refunds/${refundId}/retry`, undefined, { token: finance.token })));
    expect([r1?.status, r2?.status].sort()).toEqual([200, 409]); // a double click retries once
    await worker();
    expect(await q(`SELECT status::text AS s FROM refunds WHERE id = $1`, [refundId])).toEqual([{ s: 'succeeded' }]);
    expect(await orderView()).toMatchObject({ refundState: 'completed' });
    expect(await q(`SELECT COUNT(*)::int AS n FROM stub_refunds WHERE payment_id = $1 AND status = 'succeeded'`, [providerPayment])).toEqual([{ n: 1 }]);
    expect((await http.post(`/api/finance/refunds/${refundId}/retry`, undefined, { token: finance.token })).status).toBe(409);
    const history = (await http.get(`/api/orders/${order.id}/history`, { token: buyer.token })).json as { items: { type: string }[] };
    expect(history.items.map((h) => h.type)).toEqual(expect.arrayContaining(['refund_failed', 'refund_retried', 'refund_succeeded']));
    await expectLedgerClean(tdb.pool);
  });
});

describe('transfer and entrance (acceptance 15, 16)', () => {
  const code = async (user: TestUser, orderId: string) => (await myTickets(user)).find((t) => t.orderId === orderId);
  const scan = (codeText: string, gate = '1', token = scanner.token, eventId = ev.eventId) => http.post(`/api/scanner/events/${eventId}/scan`, { code: codeText, gate }, { token });

  it('the old QR is rejected after a transfer, the new one passes once, a second scan says when and where', async () => {
    const [alice, bob] = await createUsers(tdb.pool, api.env, 2);
    const order = await buy(alice as TestUser, 1);
    const oldTicket = await code(alice as TestUser, order.id);
    const bobEmail = ((await tdb.pool.query(`SELECT email FROM users WHERE id = $1`, [(bob as TestUser).id])).rows[0] as { email: string }).email;
    const moved = await http.post(`/api/tickets/${oldTicket?.id}/transfer`, { email: bobEmail }, { token: (alice as TestUser).token, headers: { 'idempotency-key': idem() } });
    expect(moved.status).toBe(200);
    expect(await myTickets(alice as TestUser)).toHaveLength(0);
    const newTicket = await code(bob as TestUser, order.id);
    expect(newTicket?.code).not.toBe(oldTicket?.code);
    expect((await scan(oldTicket?.code ?? '')).json).toMatchObject({ result: 'deny', reason: 'transferred' });
    const pass = await scan(newTicket?.code ?? '', '3');
    expect(pass.json).toMatchObject({ result: 'allow', reason: 'ok', gate: '3' });
    const again = (await scan(newTicket?.code ?? '', '4')).json as { result: string; reason: string; message: string; gate: string };
    expect(again).toMatchObject({ result: 'deny', reason: 'already_entered', gate: '3' });
    expect(again.message).toMatch(/Already entered at \d\d:\d\d, gate 3/);
    const kyiv = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    expect(again.message).toContain(kyiv.format(new Date((again as unknown as { enteredAt: string }).enteredAt))); // venue time, not UTC
    const history = (await http.get(`/api/orders/${order.id}/history`, { token: (alice as TestUser).token })).json as { items: { type: string }[] };
    expect(history.items.map((h) => h.type)).toContain('ticket_transferred');
  });

  it('one ticket at two gates at once passes exactly once, even with 60 simultaneous scans', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 1);
    const t = await code(buyer, order.id);
    const replies = await Promise.all(Array.from({ length: 60 }, (_, i) => scan(t?.code ?? '', String((i % 2) + 1))));
    const results = replies.map((r) => (r.json as { result: string }).result);
    expect(results.filter((r) => r === 'allow')).toHaveLength(1);
    expect(results.filter((r) => r === 'deny')).toHaveLength(59);
    expect((await q(`SELECT COUNT(*)::int AS n FROM ticket_scans WHERE ticket_id = $1 AND result = 'allow'`, [t?.id]))[0]?.['n']).toBe(1);
  });

  it('forged, edited and foreign codes are refused with a reason', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 1);
    const t = await code(buyer, order.id);
    const flip = (s: string, at: number): string => `${s.slice(0, at)}${s[at] === 'A' ? 'B' : 'A'}${s.slice(at + 1)}`;
    for (const forged of [flip(t?.code ?? '', (t?.code.length ?? 10) - 3), flip(t?.code ?? '', 6), 'v1.AAAA.BBBB', 'garbage-garbage', `${t?.code}x`, 'v2.' + (t?.code.slice(3) ?? '')]) {
      expect((await scan(forged)).json, forged).toMatchObject({ result: 'deny', reason: 'invalid_code' });
    }
    expect((await http.post(`/api/scanner/events/${ev.eventId}/scan`, { code: '' }, { token: scanner.token })).status).toBe(400);
    const other = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 5 });
    await tdb.pool.query(`INSERT INTO event_staff (event_id, user_id) VALUES ($1, $2)`, [other.eventId, scanner.id]);
    expect((await scan(t?.code ?? '', '1', scanner.token, other.eventId)).json).toMatchObject({ result: 'deny', reason: 'wrong_event' });
    expect((await q(`SELECT entered_at FROM tickets WHERE id = $1`, [t?.id]))[0]?.['entered_at']).toBeNull();
  });

  it('refunded tickets are refused at the door; scanners only work on their own event and never touch money', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await buy(buyer, 1);
    const t = await code(buyer, order.id);
    await refund(buyer, order.id);
    expect((await scan(t?.code ?? '')).json).toMatchObject({ result: 'deny', reason: 'refunded' });
    const stranger = await createUser(tdb.pool, api.env, 'scanner');
    expect((await scan(t?.code ?? '', '1', stranger.token)).status).toBe(404);
    expect((await http.get(`/api/scanner/events/${ev.eventId}/stats`, { token: stranger.token })).status).toBe(404);
    expect((await http.post(`/api/scanner/events/${ev.eventId}/scan`, { code: t?.code }, { token: buyer.token })).status).toBe(403);
    expect((await http.post(`/api/finance/orders/${order.id}/refund`, { reason: 'abc' }, { token: scanner.token, headers: { 'idempotency-key': idem() } })).status).toBe(403);
    await worker();
  });

  it('the counter shows who entered and how many are still expected', async () => {
    const stats = (await http.get(`/api/scanner/events/${ev.eventId}/stats`, { token: scanner.token })).json as { entered: number; expected: number; total: number };
    const db = (await q(`SELECT COUNT(*) FILTER (WHERE entered_at IS NOT NULL)::int AS e, COUNT(*) FILTER (WHERE entered_at IS NULL)::int AS x FROM tickets WHERE event_id = $1 AND status = 'valid'`, [ev.eventId]))[0];
    expect(stats).toMatchObject({ entered: db?.['e'], expected: db?.['x'] });
    expect(stats.entered).toBeGreaterThanOrEqual(2);
    expect(((await http.get('/api/scanner/events', { token: scanner.token })).json as { items: { id: string }[] }).items.map((e) => e.id)).toContain(ev.eventId);
  });

  it('transfer rules: unknown or same recipient, too late, used, refunded, and double transfers', async () => {
    const [alice, bob, carol] = await createUsers(tdb.pool, api.env, 3);
    const emailOf = async (u: TestUser) => ((await tdb.pool.query(`SELECT email FROM users WHERE id = $1`, [u.id])).rows[0] as { email: string }).email;
    const order = await buy(alice as TestUser, 3);
    const ts = (await myTickets(alice as TestUser)).filter((t) => t.orderId === order.id);
    const transfer = (ticketId: string, email: string, user: TestUser) => http.post(`/api/tickets/${ticketId}/transfer`, { email }, { token: user.token, headers: { 'idempotency-key': idem() } });
    expect((await transfer(ts[0]?.id ?? '', 'nobody-here@example.test', alice as TestUser)).json).toMatchObject({ error: { code: 'TRANSFER_NOT_ALLOWED', details: { reason: 'recipient_unknown' } } });
    expect((await transfer(ts[0]?.id ?? '', await emailOf(alice as TestUser), alice as TestUser)).json).toMatchObject({ error: { details: { reason: 'same_owner' } } });
    expect((await transfer(ts[0]?.id ?? '', await emailOf(bob as TestUser), bob as TestUser)).status).toBe(404); // not the owner
    const doubles = await Promise.all([transfer(ts[0]?.id ?? '', await emailOf(bob as TestUser), alice as TestUser), transfer(ts[0]?.id ?? '', await emailOf(carol as TestUser), alice as TestUser)]);
    expect(doubles.filter((r) => r.status === 200)).toHaveLength(1);
    await scan(ts[1]?.code ?? '');
    expect((await transfer(ts[1]?.id ?? '', await emailOf(bob as TestUser), alice as TestUser)).json).toMatchObject({ error: { details: { reason: 'already_used' } } });
    const itemOf = (await q(`SELECT order_item_id FROM tickets WHERE id = $1`, [ts[2]?.id]))[0]?.['order_item_id'] as string;
    await refund(alice as TestUser, order.id, [itemOf]);
    expect((await transfer(ts[2]?.id ?? '', await emailOf(bob as TestUser), alice as TestUser)).json).toMatchObject({ error: { details: { reason: 'refunded' } } });
    await worker();
  });

  it('transfers close one hour before the start', async () => {
    const [alice, bob] = await createUsers(tdb.pool, api.env, 2);
    const order = await buy(alice as TestUser, 1);
    const t = await code(alice as TestUser, order.id);
    const email = ((await tdb.pool.query(`SELECT email FROM users WHERE id = $1`, [(bob as TestUser).id])).rows[0] as { email: string }).email;
    const leadTo = async (ms: number) => {
      const starts = ((await q(`SELECT starts_at FROM events WHERE id = $1`, [ev.eventId]))[0]?.['starts_at'] as Date).getTime();
      await setClock(http, starts - Date.now() - ms);
    };
    await leadTo(59 * 60_000);
    expect((await http.post(`/api/tickets/${t?.id}/transfer`, { email }, { token: (alice as TestUser).token, headers: { 'idempotency-key': idem() } })).json).toMatchObject({ error: { details: { reason: 'too_late' } } });
    await leadTo(61 * 60_000);
    expect((await http.post(`/api/tickets/${t?.id}/transfer`, { email }, { token: (alice as TestUser).token, headers: { 'idempotency-key': idem() } })).status).toBe(200);
    await setClock(http, 0);
  });
});
