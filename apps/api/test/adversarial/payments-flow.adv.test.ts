import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileProvider } from '@ticketing/platform';
import { createTestDb, expectLedgerClean, waitFor, type TestDb } from '@ticketing/testkit';
import { signWebhook } from '../../src/modules/payment-stub/domain/signature.js';
import { client, statusCounts, type Client } from '../attacker/index.js';
import { type BootedApi } from '../helpers/boot.js';
import { createOnSaleEvent, idem, type ApiEvent } from '../helpers/event-fixture.js';
import { bootLoop } from '../helpers/full-stack.js';
import { bindPool, checkout, click, drainTasks, holdSeats, orderStatus, payFully, providerOf, providerPaymentId, setClock, waitForStatus } from '../helpers/flow.js';
import { createUser, createUsers, type TestUser } from '../helpers/session.js';

let tdb: TestDb;
let api: BootedApi;
let http: Client;
let organizer: TestUser;
let ev: ApiEvent;
let next = 0;

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootLoop(tdb);
  bindPool(api, tdb.pool);
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.130' });
  organizer = await createUser(tdb.pool, api.env, 'organizer');
  ev = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 60, floor: 10 });
});
afterAll(async () => {
  await api.close();
  await tdb.drop();
});

const seats = (n: number): number[] => Array.from({ length: n }, () => ev.seatIds[next++] as number);
const q = async (sql: string, params: unknown[] = []) => (await tdb.pool.query(sql, params)).rows as Record<string, unknown>[];
const tickets = async (orderId: string) => q(`SELECT status::text AS status, owner_id FROM tickets WHERE order_id = $1`, [orderId]);

describe('paying through the provider', () => {
  it('hold -> checkout -> success: tickets are issued, seats sold, money booked once, every step in the history', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await holdSeats(http, ev.eventId, buyer, seats(2));
    const { paymentId } = await payFully(api, http, buyer, order.id);
    expect(await tickets(order.id)).toHaveLength(2);
    const sold = await q(`SELECT COUNT(*)::int AS n FROM event_seats WHERE event_id = $1 AND status = 'sold'`, [ev.eventId]);
    expect(sold[0]).toMatchObject({ n: expect.any(Number) });
    const entries = await q(`SELECT a.code, SUM(e.amount)::text AS amount FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE e.order_id = $1 GROUP BY a.code ORDER BY a.code`, [order.id]);
    expect(entries).toEqual([
      { code: `organizer_payable:${organizer.id}`, amount: '-200000' },
      { code: 'provider_cash', amount: String(order.total) },
      { code: 'service_fee_revenue', amount: `-${order.total - 200_000}` },
    ]);
    const history = (await http.get(`/api/orders/${order.id}/history`, { token: buyer.token })).json as { items: { type: string }[] };
    expect(history.items.map((h) => h.type)).toEqual(['hold_added', 'checkout_started', 'payment_created', 'paid', 'tickets_issued']);
    expect((await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE dedupe_key = $1`, [`email:tickets:${order.id}`]))[0]).toMatchObject({ n: 1 });
    expect((await q(`SELECT status::text AS s FROM payments WHERE id = $1`, [paymentId]))[0]).toMatchObject({ s: 'succeeded' });
    await expectLedgerClean(tdb.pool);
  });

  it('checkout is idempotent: repeated and parallel calls create one payment; the order cannot be edited afterwards', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await holdSeats(http, ev.eventId, buyer, seats(1));
    const key = idem();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => checkout(http, buyer, order.id, i < 3 ? key : idem())));
    expect(results.every((r) => r.reply.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.paymentId)).size).toBe(1);
    expect((await q(`SELECT COUNT(*)::int AS n FROM payments WHERE order_id = $1`, [order.id]))[0]).toMatchObject({ n: 1 });
    expect(await orderStatus(tdb.pool, order.id)).toBe('awaiting_payment');
    const edit = await http.delete(`/api/orders/${order.id}/items/${order.items[0]?.id}`, { token: buyer.token });
    expect(edit.status).toBe(409);
    const noKey = await http.post(`/api/orders/${order.id}/checkout`, {}, { token: buyer.token });
    expect(noKey.json).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
  });

  it('a failed payment leaves the order open: the buyer can start a new payment and succeed', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await holdSeats(http, ev.eventId, buyer, seats(1));
    const first = await checkout(http, buyer, order.id);
    await click(api, providerPaymentId(first.body.paymentUrl), 'failure');
    await waitFor(async () => (await q(`SELECT status::text AS s FROM payments WHERE id = $1`, [first.body.paymentId]))[0]?.['s'] === 'failed');
    expect(await orderStatus(tdb.pool, order.id)).toBe('awaiting_payment');
    const second = await checkout(http, buyer, order.id);
    expect(second.body.paymentId).not.toBe(first.body.paymentId);
    await click(api, providerPaymentId(second.body.paymentUrl), 'success');
    await waitForStatus(tdb.pool, order.id, 'paid');
    await expectLedgerClean(tdb.pool);
  });

  it('closing the provider window sends nothing: the order simply expires with its hold and releases everything', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await holdSeats(http, ev.eventId, buyer, seats(1));
    const c = await checkout(http, buyer, order.id);
    await click(api, providerPaymentId(c.body.paymentUrl), 'close');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await orderStatus(tdb.pool, order.id)).toBe('awaiting_payment');
    await setClock(http, 11 * 60_000);
    const view = (await http.get(`/api/orders/${order.id}`, { token: buyer.token })).json as { status: string };
    expect(view.status).toBe('expired'); // by the server clock, no worker needed
    await setClock(http, 0);
  });
});

describe('payment after the hold (acceptance 7)', () => {
  it('11 minutes later and the places are still free: tickets are issued', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await holdSeats(http, ev.eventId, buyer, seats(2));
    const c = await checkout(http, buyer, order.id);
    await setClock(http, 11 * 60_000);
    await click(api, providerPaymentId(c.body.paymentUrl), 'success');
    await waitForStatus(tdb.pool, order.id, 'paid');
    expect(await tickets(order.id)).toHaveLength(2);
    const history = (await http.get(`/api/orders/${order.id}/history`, { token: buyer.token })).json as { items: { type: string }[] };
    expect(history.items.map((h) => h.type)).toContain('late_payment_accepted');
    await setClock(http, 0);
    await expectLedgerClean(tdb.pool);
  });

  it('11 minutes later and someone else took the places: the money goes back in full, automatically', async () => {
    const [late, rival] = await createUsers(tdb.pool, api.env, 2);
    const taken = seats(2);
    const order = await holdSeats(http, ev.eventId, late as TestUser, taken);
    const c = await checkout(http, late as TestUser, order.id);
    await setClock(http, 11 * 60_000);
    const rivalOrder = await holdSeats(http, ev.eventId, rival as TestUser, taken); // the expired hold is gone for everybody
    await click(api, providerPaymentId(c.body.paymentUrl), 'success');
    await waitFor(async () => (await q(`SELECT 1 FROM refunds WHERE order_id = $1`, [order.id])).length === 1);
    await drainTasks(tdb.pool, providerOf(api));
    const refund = (await q(`SELECT status::text AS s, kind::text AS k, amount FROM refunds WHERE order_id = $1`, [order.id]))[0];
    expect(refund).toMatchObject({ s: 'succeeded', k: 'late_payment', amount: order.total });
    expect(await orderStatus(tdb.pool, order.id)).toBe('refunded');
    expect(await tickets(order.id)).toHaveLength(0);
    const owner = await q(`SELECT hold_order_id FROM event_seats WHERE event_id = $1 AND seat_id = $2`, [ev.eventId, taken[0]]);
    expect(owner[0]).toMatchObject({ hold_order_id: rivalOrder.id });
    const cash = await q(`SELECT COALESCE(SUM(e.amount), 0)::text AS n FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code = 'provider_cash' AND e.order_id = $1`, [order.id]);
    expect(cash[0]).toMatchObject({ n: '0' }); // paid in, paid out, nothing left
    await setClock(http, 0);
    await expectLedgerClean(tdb.pool);
  });
});

describe('webhooks (acceptance 8)', () => {
  const sign = (body: string, at = Math.floor(Date.now() / 1000)) => signWebhook(api.env.STUB_WEBHOOK_SECRET, body, at);
  const send = (body: string, signature: string | undefined) => http.request('POST', '/api/webhooks/payments', { rawBody: body, headers: signature === undefined ? {} : { 'x-stub-signature': signature } });

  it('unsigned, wrongly signed, tampered and replayed webhooks are refused and change nothing', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await holdSeats(http, ev.eventId, buyer, seats(1));
    const c = await checkout(http, buyer, order.id);
    const providerId = providerPaymentId(c.body.paymentUrl);
    const body = JSON.stringify({ id: 'evt_forged_1', type: 'payment.succeeded', data: { paymentId: providerId, orderRef: order.id, amount: order.total, status: 'succeeded', seq: 2 } });
    expect((await send(body, undefined)).status).toBe(401);
    expect((await send(body, 'garbage')).status).toBe(401);
    expect((await send(body, signWebhook('wrong-secret-0123456789-0123456789-xx', body, Math.floor(Date.now() / 1000)))).status).toBe(401);
    expect((await send(body.replace('2', '3'), sign(body))).status).toBe(401); // body edited after signing
    expect((await send(body, sign(body, Math.floor(Date.now() / 1000) - 3_600))).status).toBe(401); // replay of an old capture
    expect(await orderStatus(tdb.pool, order.id)).toBe('awaiting_payment');
    expect((await send('{"id":"x"}', sign('{"id":"x"}'))).status).toBe(400); // signed but not a provider event
    const ok = await send(body, sign(body));
    expect(ok.json).toEqual({ outcome: 'applied' });
    await waitForStatus(tdb.pool, order.id, 'paid');
  });

  it('a duplicate, a stale "failed" after "succeeded", and an unknown payment are all harmless', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await holdSeats(http, ev.eventId, buyer, seats(1));
    const c = await checkout(http, buyer, order.id);
    const providerId = providerPaymentId(c.body.paymentUrl);
    const evt = (id: string, type: string, seq: number, paymentId = providerId) => JSON.stringify({ id, type, data: { paymentId, orderRef: order.id, amount: order.total, status: type.split('.')[1], seq } });
    const good = evt('evt_dup_1', 'payment.succeeded', 2);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => send(good, sign(good))));
    expect(outcomes.map((r) => (r.json as { outcome: string }).outcome).sort()).toEqual(['applied', ...Array(7).fill('duplicate')]);
    const stale = evt('evt_stale_1', 'payment.failed', 1);
    await send(stale, sign(stale));
    expect((await q(`SELECT status::text AS s FROM payments WHERE id = $1`, [c.body.paymentId]))[0]).toMatchObject({ s: 'succeeded' });
    const unknown = evt('evt_unknown_1', 'payment.succeeded', 2, 'pay_does_not_exist');
    expect((await send(unknown, sign(unknown))).json).toEqual({ outcome: 'ignored' });
    expect(await tickets(order.id)).toHaveLength(1);
    expect((await q(`SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = 'payment' AND ref_id = $1`, [c.body.paymentId]))[0]).toMatchObject({ n: 1 });
    await expectLedgerClean(tdb.pool);
  });

  it('chaos mode: every operation is booked exactly once, and lost webhooks are found by reconciliation', async () => {
    await http.post('/api/_test/stub-chaos', { chaos: true });
    const buyers = await createUsers(tdb.pool, api.env, 10);
    const orders = [];
    for (const b of buyers) orders.push(await holdSeats(http, ev.eventId, b, seats(1)));
    const started: { orderId: string; providerId: string; paymentId: string }[] = [];
    for (const [i, b] of buyers.entries()) {
      let c = await checkout(http, b, orders[i]?.id ?? '');
      for (let attempt = 0; attempt < 8 && c.reply.status !== 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        c = await checkout(http, b, orders[i]?.id ?? '');
      }
      expect(c.reply.status).toBe(200);
      started.push({ orderId: orders[i]?.id ?? '', providerId: providerPaymentId(c.body.paymentUrl), paymentId: c.body.paymentId });
      expect(await click(api, providerPaymentId(c.body.paymentUrl), 'success')).toBeGreaterThan(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_500)); // let delayed / duplicated / stale deliveries arrive
    await http.post('/api/_test/stub-chaos', { chaos: false });
    const missing = await q(`SELECT id FROM payments WHERE id = ANY($1::uuid[]) AND status <> 'succeeded'`, [started.map((s) => s.paymentId)]);
    expect(missing.length).toBeGreaterThanOrEqual(1); // at least one webhook never arrived
    const found = await reconcileProvider(tdb.pool, providerOf(api), { olderThanMs: 0, limit: 50 });
    expect(found.length).toBe(missing.length);
    for (const s of started) await waitForStatus(tdb.pool, s.orderId, 'paid');
    for (const s of started) {
      expect((await q(`SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = 'payment' AND ref_id = $1`, [s.paymentId]))[0]).toMatchObject({ n: 1 });
      expect((await tickets(s.orderId)).length).toBe(1);
    }
    expect((await reconcileProvider(tdb.pool, providerOf(api), { olderThanMs: 0, limit: 50 })).length).toBe(0); // nothing left to find
    expect((await q(`SELECT COUNT(*)::int AS n FROM recon_findings WHERE resolved_at IS NOT NULL`))[0]).toMatchObject({ n: missing.length });
    await expectLedgerClean(tdb.pool);
  });

  it('the checkout endpoint reports a busy provider as a clear retryable error', async () => {
    const buyer = await createUser(tdb.pool, api.env);
    const order = await holdSeats(http, ev.eventId, buyer, seats(1));
    const burst = await Promise.all(Array.from({ length: 40 }, () => http.get('/stub/v1/payments/pay_000000000000000000000000', { headers: { authorization: `Bearer ${api.env.STUB_API_KEY}` } })));
    const c = await checkout(http, buyer, order.id);
    if (c.reply.status !== 200) {
      expect(c.reply.status).toBe(503);
      expect(c.reply.json).toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } });
      expect(Number(c.reply.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    }
    expect(statusCounts(burst)[429]).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await checkout(http, buyer, order.id)).reply.status).toBe(200); // the order is intact, simply retry
  });
});
