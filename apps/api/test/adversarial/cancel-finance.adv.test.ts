import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, expectLedgerClean, ledgerReport, type TestDb } from '@ticketing/testkit';
import { client, statusCounts, type Client } from '../attacker/index.js';
import { type BootedApi } from '../helpers/boot.js';
import { createOnSaleEvent, idem, type ApiEvent } from '../helpers/event-fixture.js';
import { bootLoop } from '../helpers/full-stack.js';
import { bindPool, drainTasks, holdSeats, payFully, providerOf, setClock } from '../helpers/flow.js';
import { createUser, createUsers, type TestUser } from '../helpers/session.js';

let tdb: TestDb;
let api: BootedApi;
let http: Client;
let organizer: TestUser;
let finance: TestUser;
let ev: ApiEvent;

const q = async (sql: string, params: unknown[] = []) => (await tdb.pool.query(sql, params)).rows as Record<string, unknown>[];

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootLoop(tdb);
  bindPool(api, tdb.pool);
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.160' });
  organizer = await createUser(tdb.pool, api.env, 'organizer');
  finance = await createUser(tdb.pool, api.env, 'finance');
  ev = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 120, floor: 20 });
});
afterAll(async () => {
  await api.close();
  await tdb.drop();
});

describe('event cancellation (acceptance 11, scaled)', () => {
  let buyers: readonly TestUser[];
  let orderIds: string[];

  it('sets up 40 paid orders, an unpaid hold and an order awaiting payment', async () => {
    buyers = await createUsers(tdb.pool, api.env, 40);
    orderIds = [];
    for (const [i, b] of buyers.entries()) {
      const order = await holdSeats(http, ev.eventId, b, [ev.seatIds[i * 2] as number, ev.seatIds[i * 2 + 1] as number]);
      await payFully(api, http, b, order.id);
      orderIds.push(order.id);
    }
    const [holder, payer] = await createUsers(tdb.pool, api.env, 2);
    await holdSeats(http, ev.eventId, holder as TestUser, [ev.seatIds[100] as number]);
    const pending = await holdSeats(http, ev.eventId, payer as TestUser, [ev.seatIds[101] as number]);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const c = await http.post(`/api/orders/${pending.id}/checkout`, {}, { token: (payer as TestUser).token, headers: { 'idempotency-key': idem() } });
      if (c.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect((await q(`SELECT COUNT(*)::int AS n FROM orders WHERE event_id = $1 AND status = 'paid'`, [ev.eventId]))[0]?.['n']).toBe(40);
  });

  it('cancelling stops sales, transfers and entry at once and creates one refund per order in one step', async () => {
    const stranger = await createUser(tdb.pool, api.env, 'organizer');
    expect((await http.post(`/api/organizer/events/${ev.eventId}/cancel`, {}, { token: stranger.token })).status).toBe(404);
    const started = Date.now();
    const res = await http.post(`/api/organizer/events/${ev.eventId}/cancel`, {}, { token: organizer.token });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.json).toMatchObject({ status: 'cancelled', total: 40, requested: 40, succeeded: 0 });
    const [late] = await createUsers(tdb.pool, api.env, 1);
    expect((await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: [ev.seatIds[110]] }, { token: (late as TestUser).token, headers: { 'idempotency-key': idem() } })).json).toMatchObject({ error: { code: 'EVENT_NOT_ON_SALE' } });
    const buyer = buyers[0] as TestUser;
    const ticket = ((await http.get('/api/tickets', { token: buyer.token })).json as { items: { id: string; code: string; status: string }[] }).items[0];
    expect(ticket?.status).toBe('refunded');
    const other = await createUser(tdb.pool, api.env);
    expect((await http.post(`/api/tickets/${ticket?.id}/transfer`, { email: 'x@example.test' }, { token: buyer.token, headers: { 'idempotency-key': idem() } })).status).toBe(422);
    expect(other.id).toBeTruthy();
    expect(await q(`SELECT status::text AS s FROM orders WHERE event_id = $1 AND status IN ('holding', 'awaiting_payment')`, [ev.eventId])).toEqual([]);
    expect((await q(`SELECT COUNT(*)::int AS n FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1 AND r.kind = 'event_cancelled'`, [ev.eventId]))[0]?.['n']).toBe(40);
    expect((await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE kind = 'refund_execute'`))[0]?.['n']).toBe(40);
    expect((await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE dedupe_key LIKE 'email:cancel:%'`))[0]?.['n']).toBe(40);
    const refundedFee = await q(`SELECT SUM(fee_amount)::int AS f, SUM(price_amount)::int AS p FROM refunds WHERE kind = 'event_cancelled'`);
    expect(refundedFee[0]).toMatchObject({ f: 40 * 2 * 5_000, p: 40 * 2 * 100_000 }); // the service fee goes back too
  });

  it('a repeated cancel changes nothing; the refund never goes beyond what was paid', async () => {
    const again = await Promise.all([http.post(`/api/organizer/events/${ev.eventId}/cancel`, {}, { token: organizer.token }), http.post(`/api/organizer/events/${ev.eventId}/cancel`, {}, { token: organizer.token })]);
    expect(again.every((r) => r.status === 200)).toBe(true);
    expect((await q(`SELECT COUNT(*)::int AS n FROM refunds WHERE kind = 'event_cancelled'`))[0]?.['n']).toBe(40);
    expect((await q(`SELECT COUNT(*)::int AS n FROM tasks WHERE kind = 'refund_execute'`))[0]?.['n']).toBe(40);
    const over = await q(`SELECT 1 FROM refunds r JOIN orders o ON o.id = r.order_id GROUP BY o.id, o.total HAVING SUM(r.amount) > o.total`);
    expect(over).toEqual([]);
    expect((await http.post(`/api/orders/${orderIds[0]}/refund`, {}, { token: (buyers[0] as TestUser).token, headers: { 'idempotency-key': idem() } })).status).toBe(422);
  });

  it('refunds run through the provider (in chaos mode too): every order is refunded exactly once, progress is visible', async () => {
    await http.post('/api/_test/stub-chaos', { chaos: true });
    const seen: number[] = [];
    const watcher = setInterval(() => {
      void http.get(`/api/organizer/events/${ev.eventId}/cancellation`, { token: organizer.token }).then((r) => seen.push((r.json as { succeeded: number }).succeeded));
    }, 150);
    await drainTasks(tdb.pool, providerOf(api));
    clearInterval(watcher);
    await new Promise((resolve) => setTimeout(resolve, 4_000)); // delayed / duplicate webhooks of chaos mode land meanwhile
    await http.post('/api/_test/stub-chaos', { chaos: false });
    const progress = (await http.get(`/api/organizer/events/${ev.eventId}/cancellation`, { token: organizer.token })).json as { succeeded: number; failed: number; amountRefunded: number; amountTotal: number };
    expect(progress).toMatchObject({ succeeded: 40, failed: 0, amountRefunded: 40 * 210_000, amountTotal: 40 * 210_000 });
    expect(seen.some((n) => n > 0 && n < 40)).toBe(true); // intermediate progress was observable
    expect((await q(`SELECT COUNT(*)::int AS n FROM stub_refunds`))[0]?.['n']).toBe(40);
    expect((await q(`SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = 'refund'`))[0]?.['n']).toBe(40);
    for (const id of orderIds) expect((await q(`SELECT status::text AS s FROM orders WHERE id = $1`, [id]))[0]?.['s']).toBe('refunded');
    const cash = await q(`SELECT COALESCE(SUM(e.amount), 0)::text AS n FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code = 'provider_cash' AND e.order_id = ANY($1::uuid[])`, [orderIds]);
    expect(cash[0]).toMatchObject({ n: '0' });
    await expectLedgerClean(tdb.pool);
  });

  it('the late payment of the order that was awaiting payment is refunded too', async () => {
    const awaiting = await q(`SELECT p.provider_payment_id AS pid, o.id AS oid FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.event_id = $1 AND o.status = 'expired'`, [ev.eventId]);
    expect(awaiting).toHaveLength(1); // the plain holder never created a payment
    const target = awaiting.find((r) => r['pid']);
    const c = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.161' });
    expect((await c.post(`/stub/pay/${target?.['pid']}/success`, undefined)).status).toBe(303); // redirect back to the shop
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await drainTasks(tdb.pool, providerOf(api));
    expect((await q(`SELECT status::text AS s FROM orders WHERE id = $1`, [target?.['oid']]))[0]?.['s']).toBe('refunded');
    await expectLedgerClean(tdb.pool);
  });
});

describe('finance: reports, reconciliation, jobs', () => {
  let ev2: ApiEvent;

  it('builds sales for an organizer and a period and the numbers agree with the ledger', async () => {
    ev2 = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 20 });
    const [a, b] = await createUsers(tdb.pool, api.env, 2);
    for (const [i, u] of [a, b].entries()) {
      const order = await holdSeats(http, ev2.eventId, u as TestUser, [ev2.seatIds[i] as number]);
      await payFully(api, http, u as TestUser, order.id);
    }
    const sales = (await http.get('/api/organizer/reports/sales', { token: organizer.token, query: { eventId: ev2.eventId } })).json as { byHour: { tickets: number; gross: number }[]; byZone: { gross: number }[]; events: { id: string; capacity: number; sold: number; fillPercent: number }[] };
    expect(sales.byHour.reduce((n, h) => n + h.tickets, 0)).toBe(2);
    expect(sales.byHour.reduce((n, h) => n + h.gross, 0)).toBe(200_000);
    expect(sales.byZone[0]?.gross).toBe(200_000);
    expect(sales.events[0]).toMatchObject({ id: ev2.eventId, capacity: 20, sold: 2, fillPercent: 10 });
    expect((await http.get('/api/organizer/reports/sales', { token: finance.token })).status).toBe(403);
    expect((await http.get('/api/organizer/reports/sales', { token: organizer.token, query: { from: 'yesterday' } })).status).toBe(400);
  });

  it('the finance report shows sales, fees, commission, refunds, payouts per period (in the URL) and per organizer', async () => {
    const report = (await http.get('/api/finance/reports', { token: finance.token })).json as { sales: number; serviceFees: number; refunds: number; byOrganizer: { organizerId: string; sales: number }[] };
    expect(report.sales).toBe(40 * 200_000 + 100_000 /* late payment, refunded */ + 2 * 100_000);
    expect(report.refunds).toBeGreaterThan(40 * 200_000);
    expect(report.byOrganizer.find((o) => o.organizerId === organizer.id)?.sales).toBe(report.sales);
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
    expect(((await http.get('/api/finance/reports', { token: finance.token, query: { from: future } })).json as { sales: number }).sales).toBe(0);
    expect((await http.get('/api/finance/reports', { token: (await createUser(tdb.pool, api.env)).token })).status).toBe(403);
  });

  it('reconciliation: the sum of all entries is zero, balances equal their entries, nothing is stuck - and it notices corruption', async () => {
    const clean = (await http.get('/api/finance/reconciliation', { token: finance.token })).json as { ledgerSum: number; unbalancedTransactions: number; balanceMismatches: unknown[]; rollupMismatches: number; ok: boolean; stuck: { pendingRefunds: number; failedRefunds: number } };
    expect(clean).toMatchObject({ ledgerSum: 0, unbalancedTransactions: 0, balanceMismatches: [], rollupMismatches: 0, ok: true });
    expect(clean.stuck).toMatchObject({ pendingRefunds: 0, failedRefunds: 0 });
    await tdb.pool.query(`UPDATE sales_hourly SET gross = gross + 1 WHERE ctid = (SELECT ctid FROM sales_hourly LIMIT 1)`);
    expect(((await http.get('/api/finance/reconciliation', { token: finance.token })).json as { ok: boolean; rollupMismatches: number })).toMatchObject({ ok: false, rollupMismatches: 1 });
    await tdb.pool.query(`UPDATE sales_hourly SET gross = gross - 1 WHERE ctid = (SELECT ctid FROM sales_hourly LIMIT 1)`);
    expect((await ledgerReport(tdb.pool)).total).toBe(0n);
  });

  it('finance sees failed and stuck jobs and restarts them; restarting twice or a healthy job is refused', async () => {
    await tdb.pool.query(`INSERT INTO tasks (kind, dedupe_key, status, attempts, last_error) VALUES ('refund_execute', 'refund:failed-demo', 'failed', 8, 'provider unavailable')`);
    await tdb.pool.query(`INSERT INTO tasks (kind, dedupe_key, run_at) VALUES ('email', 'email:stuck-demo', app_now() - interval '10 minutes')`);
    await tdb.pool.query(`INSERT INTO tasks (kind, dedupe_key, run_at) VALUES ('email', 'email:healthy-demo', app_now() + interval '10 minutes')`);
    const failed = (await http.get('/api/finance/jobs', { token: finance.token })).json as { items: { id: string; dedupeKey: string; lastError: string; status: string }[] };
    expect(failed.items.map((j) => j.dedupeKey)).toContain('refund:failed-demo');
    expect(failed.items.find((j) => j.dedupeKey === 'refund:failed-demo')).toMatchObject({ status: 'failed', lastError: 'provider unavailable' });
    const stuck = (await http.get('/api/finance/jobs', { token: finance.token, query: { status: 'stuck' } })).json as { items: { id: string; dedupeKey: string; stuck: boolean }[] };
    expect(stuck.items.map((j) => j.dedupeKey)).toEqual(['email:stuck-demo']);
    const id = failed.items.find((j) => j.dedupeKey === 'refund:failed-demo')?.id ?? '';
    const restarts = await Promise.all([http.post(`/api/finance/jobs/${id}/restart`, {}, { token: finance.token }), http.post(`/api/finance/jobs/${id}/restart`, {}, { token: finance.token })]);
    expect(statusCounts(restarts)).toEqual({ 200: 1, 409: 1 });
    expect((await q(`SELECT status::text AS s, attempts FROM tasks WHERE dedupe_key = 'refund:failed-demo'`))[0]).toMatchObject({ s: 'pending', attempts: 0 });
    const healthy = (await q(`SELECT id FROM tasks WHERE dedupe_key = 'email:healthy-demo'`))[0]?.['id'];
    expect((await http.post(`/api/finance/jobs/${healthy}/restart`, {}, { token: finance.token })).status).toBe(409);
    expect((await http.post(`/api/finance/jobs/${id}/restart`, {}, { token: organizer.token })).status).toBe(403);
    expect((await http.post(`/api/finance/jobs/not-a-uuid/restart`, {}, { token: finance.token })).status).toBe(400);
  });

  it('finance cannot change events and organizers cannot see money of others', async () => {
    expect((await http.post(`/api/organizer/events/${ev2.eventId}/cancel`, {}, { token: finance.token })).status).toBe(403);
    expect((await http.patch(`/api/organizer/events/${ev2.eventId}`, { description: 'x' }, { token: finance.token })).status).toBe(403);
    expect((await http.get('/api/finance/reconciliation', { token: organizer.token })).status).toBe(403);
    await setClock(http, 0);
  });
});
