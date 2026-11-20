import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/test-db.js';
import { createAwaitingOrder, createWorld, expectLedgerClean, ledgerReport, payOrder, type World } from '../helpers/fixtures.js';

let tdb: TestDb;
let w: World;

beforeAll(async () => {
  tdb = await createTestDb();
  w = await createWorld(tdb.pool, { seats: 40 });
});
afterAll(async () => {
  await tdb.drop();
});

const balanceOf = async (code: string): Promise<number> => {
  const r = await tdb.pool.query(`SELECT balance::text AS b FROM accounts WHERE code = $1`, [code]);
  return Number((r.rows[0] as { b: string } | undefined)?.b ?? 0);
};

describe('payment posting', () => {
  it('posts balanced entries: cash = price+fee, organizer liability = price, fee revenue = fee', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [0, 1]); // 2 x (1000 UAH + 50 UAH fee)
    await payOrder(tdb.pool, order);
    const entries = await tdb.pool.query(
      `SELECT a.code, e.amount::text AS amount FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE e.order_id = $1 ORDER BY a.code`,
      [order.orderId],
    );
    expect(entries.rows).toEqual([
      { code: `organizer_payable:${w.organizerId}`, amount: '-200000' },
      { code: 'provider_cash', amount: '210000' },
      { code: 'service_fee_revenue', amount: '-10000' },
    ]);
    await expectLedgerClean(tdb.pool);
  });

  it('is idempotent: posting the same payment again changes nothing', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [2]);
    await payOrder(tdb.pool, order);
    const before = (await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM ledger_entries`)).rows[0] as { n: number };
    const again = await tdb.pool.query(`SELECT post_payment($1) AS posted`, [order.paymentId]);
    expect((again.rows[0] as { posted: boolean }).posted).toBe(false);
    const after = (await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM ledger_entries`)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
    const sales = await tdb.pool.query(`SELECT SUM(tickets)::int AS t FROM sales_hourly WHERE event_id = $1`, [w.eventId]);
    expect(sales.rows[0]).toMatchObject({ t: 3 });
  });

  it('20 concurrent postings of one payment create exactly one transaction', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [3]);
    await tdb.pool.query(`UPDATE payments SET status = 'succeeded' WHERE id = $1`, [order.paymentId]);
    await tdb.pool.query(`UPDATE orders SET status = 'paid', paid_at = app_now() WHERE id = $1`, [order.orderId]);
    await Promise.all(Array.from({ length: 20 }, () => tdb.pool.query(`SELECT post_payment($1)`, [order.paymentId])));
    const txns = await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE kind = 'payment' AND ref_id = $1`, [order.paymentId]);
    expect(txns.rows[0]).toMatchObject({ n: 1 });
    await expectLedgerClean(tdb.pool);
  });

  it('rejects a payment whose amount differs from the order items', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [4]);
    await tdb.pool.query(`UPDATE payments SET amount = amount + 1 WHERE id = $1`, [order.paymentId]);
    await tdb.pool.query(`UPDATE orders SET status = 'paid', paid_at = app_now() WHERE id = $1`, [order.orderId]);
    await expect(tdb.pool.query(`SELECT post_payment($1)`, [order.paymentId])).rejects.toThrow(/does not match/);
  });
});

describe('journal tampering', () => {
  it('rejects UPDATE, DELETE and TRUNCATE of ledger rows', async () => {
    await expect(tdb.pool.query(`UPDATE ledger_entries SET amount = amount + 1`)).rejects.toThrow(/append-only/);
    await expect(tdb.pool.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/append-only/);
    await expect(tdb.pool.query(`TRUNCATE ledger_entries CASCADE`)).rejects.toThrow(/append-only/);
    await expect(tdb.pool.query(`UPDATE ledger_transactions SET kind = 'x'`)).rejects.toThrow(/append-only/);
    await expect(tdb.pool.query(`DELETE FROM ledger_transactions`)).rejects.toThrow(/append-only/);
  });

  it('rejects an unbalanced transaction at commit', async () => {
    const c = await tdb.pool.connect();
    try {
      await c.query('BEGIN');
      const txn = (await c.query(`INSERT INTO ledger_transactions (kind, ref_id) VALUES ('manual', gen_random_uuid()) RETURNING id`)).rows[0] as { id: string };
      const acc = (await c.query(`SELECT id FROM accounts LIMIT 2`)).rows as { id: string }[];
      await c.query(`INSERT INTO ledger_entries (txn_id, account_id, amount) VALUES ($1, $2, 100), ($1, $3, -99)`, [txn.id, acc[0]?.id, acc[1]?.id]);
      await expect(c.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    await expectLedgerClean(tdb.pool);
  });

  it('rejects a one-sided transaction and a zero amount', async () => {
    const c = await tdb.pool.connect();
    try {
      await c.query('BEGIN');
      const txn = (await c.query(`INSERT INTO ledger_transactions (kind, ref_id) VALUES ('manual', gen_random_uuid()) RETURNING id`)).rows[0] as { id: string };
      const acc = (await c.query(`SELECT id FROM accounts LIMIT 1`)).rows[0] as { id: string };
      await expect(c.query(`INSERT INTO ledger_entries (txn_id, account_id, amount) VALUES ($1, $2, 0)`, [txn.id, acc.id])).rejects.toThrow(/amount/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    const c2 = await tdb.pool.connect();
    try {
      await c2.query('BEGIN');
      const txn = (await c2.query(`INSERT INTO ledger_transactions (kind, ref_id) VALUES ('manual', gen_random_uuid()) RETURNING id`)).rows[0] as { id: string };
      const acc = (await c2.query(`SELECT id FROM accounts LIMIT 1`)).rows[0] as { id: string };
      await c2.query(`INSERT INTO ledger_entries (txn_id, account_id, amount) VALUES ($1, $2, 5)`, [txn.id, acc.id]);
      await expect(c2.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await c2.query('ROLLBACK').catch(() => undefined);
      c2.release();
    }
  });

  it('forbids editing a balance by hand', async () => {
    await expect(tdb.pool.query(`UPDATE accounts SET balance = balance + 1`)).rejects.toThrow(/ledger entries/);
    await expect(tdb.pool.query(`UPDATE accounts SET code = code || 'x'`)).rejects.toThrow(/immutable/);
  });
});

describe('refunds and payout', () => {
  it('refund posting reverses exactly what was refunded; cash and liabilities follow', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [5, 6]);
    await payOrder(tdb.pool, order);
    const cashBefore = await balanceOf('provider_cash');
    const refund = (await tdb.pool.query(
      `INSERT INTO refunds (order_id, kind, status, price_amount, fee_amount, amount) VALUES ($1, 'user', 'succeeded', 50000, 0, 50000) RETURNING id`,
      [order.orderId],
    )).rows[0] as { id: string };
    await tdb.pool.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1, $2, 50000, 0)`, [refund.id, order.itemIds[0]]);
    await tdb.pool.query(`SELECT post_refund($1)`, [refund.id]);
    expect(await balanceOf('provider_cash')).toBe(cashBefore - 50_000);
    expect((await tdb.pool.query(`SELECT post_refund($1) AS p`, [refund.id])).rows[0]).toMatchObject({ p: false });
    await expectLedgerClean(tdb.pool);
  });

  it('refund items cannot exceed what was paid, twice, or cross orders', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [7]);
    await payOrder(tdb.pool, order);
    const refund = (await tdb.pool.query(`INSERT INTO refunds (order_id, kind, price_amount, fee_amount, amount) VALUES ($1, 'user', 100000, 5000, 105000) RETURNING id`, [order.orderId])).rows[0] as { id: string };
    await expect(tdb.pool.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1, $2, 100001, 0)`, [refund.id, order.itemIds[0]])).rejects.toThrow(/exceeds/);
    await expect(tdb.pool.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1, $2, 100000, 5001)`, [refund.id, order.itemIds[0]])).rejects.toThrow(/exceeds/);
    await tdb.pool.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1, $2, 100000, 5000)`, [refund.id, order.itemIds[0]]);
    const second = (await tdb.pool.query(`INSERT INTO refunds (order_id, kind, price_amount, fee_amount, amount) VALUES ($1, 'user', 1, 0, 1) RETURNING id`, [order.orderId])).rows[0] as { id: string };
    await expect(tdb.pool.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1, $2, 1, 0)`, [second.id, order.itemIds[0]])).rejects.toThrow(/exceed/); // the order-level cap fires before the unique index
    const other = await createAwaitingOrder(tdb.pool, w, [8]);
    await expect(tdb.pool.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1, $2, 1, 0)`, [second.id, other.itemIds[0]])).rejects.toThrow(/does not belong/);
    // a provider-rejected refund frees the ticket for a new attempt
    await tdb.pool.query(`UPDATE refund_items SET active = false WHERE refund_id = $1`, [refund.id]);
    await tdb.pool.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1, $2, 100000, 5000)`, [second.id, order.itemIds[0]]);
  });

  it('a ticket cannot be refunded twice even when the order total would allow it (unique index)', async () => {
    const order = await createAwaitingOrder(tdb.pool, w, [9, 10]);
    await payOrder(tdb.pool, order);
    const r1 = (await tdb.pool.query(`INSERT INTO refunds (order_id, kind, price_amount, fee_amount, amount) VALUES ($1, 'user', 100000, 0, 100000) RETURNING id`, [order.orderId])).rows[0] as { id: string };
    const r2 = (await tdb.pool.query(`INSERT INTO refunds (order_id, kind, price_amount, fee_amount, amount) VALUES ($1, 'user', 1000, 0, 1000) RETURNING id`, [order.orderId])).rows[0] as { id: string };
    await tdb.pool.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1, $2, 100000, 0)`, [r1.id, order.itemIds[0]]);
    await expect(tdb.pool.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1, $2, 1000, 0)`, [r2.id, order.itemIds[0]])).rejects.toThrow(/refund_items_once_idx|duplicate key/);
  });

  it('payout row must satisfy amount = sales - refunds - commission and the payout nets organizer liability', async () => {
    const e2 = await createWorld(tdb.pool, { seats: 5 });
    const order = await createAwaitingOrder(tdb.pool, e2, [0, 1, 2]); // 3 x 1000 UAH
    await payOrder(tdb.pool, order);
    await expect(
      tdb.pool.query(`INSERT INTO payouts (event_id, organizer_id, sales, refunds, commission, amount, due_at) VALUES ($1,$2,300000,0,24000,277000, app_now())`, [e2.eventId, e2.organizerId]),
    ).rejects.toThrow(/check/);
    const payout = (await tdb.pool.query(
      `INSERT INTO payouts (event_id, organizer_id, sales, refunds, commission, amount, due_at) VALUES ($1,$2,300000,0,24000,276000, app_now()) RETURNING id`,
      [e2.eventId, e2.organizerId],
    )).rows[0] as { id: string };
    await tdb.pool.query(`SELECT post_payout($1)`, [payout.id]);
    expect(await balanceOf(`organizer_payable:${e2.organizerId}`)).toBe(0);
    expect(await balanceOf('commission_revenue')).toBe(-24_000);
    expect(await balanceOf('payout_cash')).toBe(-276_000);
    await expectLedgerClean(tdb.pool);
  });
});

describe('invariant sweep', () => {
  it('ledger stays clean after many random orders and refunds', async () => {
    const world = await createWorld(tdb.pool, { seats: 60 });
    for (let i = 0; i < 12; i += 1) {
      const order = await createAwaitingOrder(tdb.pool, world, [i * 2, i * 2 + 1], 10_000 + i * 777, 2_000 + i);
      await payOrder(tdb.pool, order);
      if (i % 3 === 0) {
        const refund = (await tdb.pool.query(`INSERT INTO refunds (order_id, kind, status, price_amount, fee_amount, amount) VALUES ($1,'event_cancelled','succeeded',$2,$3,$4) RETURNING id`, [order.orderId, order.price * 2, order.fee * 2, (order.price + order.fee) * 2])).rows[0] as { id: string };
        for (const itemId of order.itemIds) {
          await tdb.pool.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1,$2,$3,$4)`, [refund.id, itemId, order.price, order.fee]);
        }
        await tdb.pool.query(`SELECT post_refund($1)`, [refund.id]);
      }
    }
    const report = await ledgerReport(tdb.pool);
    expect(report).toEqual({ total: 0n, unbalancedTransactions: 0, balanceMismatches: 0, dailyMismatches: 0 });
    const rollup = await tdb.pool.query(
      `SELECT (SELECT SUM(gross + fees - refunds) FROM sales_hourly WHERE event_id = $1)::text AS rolled,
              (SELECT -SUM(amount) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code LIKE 'organizer_payable:%' AND e.event_id = $1)::text AS payable,
              (SELECT -SUM(amount) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code = 'service_fee_revenue' AND e.event_id = $1)::text AS fees`,
      [world.eventId],
    );
    const r = rollup.rows[0] as { rolled: string; payable: string; fees: string };
    expect(BigInt(r.rolled)).toBe(BigInt(r.payable) + BigInt(r.fees));
  });
});
