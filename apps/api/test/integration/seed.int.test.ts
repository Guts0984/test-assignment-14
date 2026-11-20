import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../../src/seed/run-seed.js';
import { SMALL_SEED } from '../../src/seed/params.js';
import { createTestDb, type TestDb } from '../helpers/test-db.js';
import { expectLedgerClean } from '../helpers/fixtures.js';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
  const result = await runSeed(tdb.pool, SMALL_SEED, '$argon2id$seed-test-hash');
  expect(result.skipped).toBe(false);
}, 120_000);
afterAll(async () => {
  await tdb.drop();
});

const scalar = async (sql: string): Promise<number> => Number(((await tdb.pool.query(sql)).rows[0] as { n: string }).n);

describe('seed (small scale, same shape as the full one)', () => {
  it('creates the documented amounts', async () => {
    expect(await scalar(`SELECT COUNT(*) AS n FROM users`)).toBe(SMALL_SEED.users);
    expect(await scalar(`SELECT COUNT(*) AS n FROM venues`)).toBe(SMALL_SEED.venues);
    expect(await scalar(`SELECT COUNT(*) AS n FROM events`)).toBe(SMALL_SEED.events);
    expect(await scalar(`SELECT COUNT(*) AS n FROM tickets`)).toBe(SMALL_SEED.tickets);
    expect(await scalar(`SELECT COUNT(DISTINCT role) AS n FROM users`)).toBe(4);
  });

  it('has one arena with seats and a dance floor', async () => {
    const r = await tdb.pool.query(`SELECT v.name, COUNT(s.id)::int AS seats, (SELECT capacity FROM zones z WHERE z.venue_id = v.id AND z.kind = 'general') AS floor FROM venues v LEFT JOIN seats s ON s.venue_id = v.id GROUP BY v.id ORDER BY seats DESC LIMIT 1`);
    expect(r.rows[0]).toMatchObject({ name: 'Arena', seats: SMALL_SEED.arenaSeats, floor: SMALL_SEED.arenaFloor });
  });

  it('some events start selling about 10 minutes after the seed and have no sales yet', async () => {
    const r = await tdb.pool.query(
      `SELECT COUNT(*)::int AS n, MAX(ABS(EXTRACT(EPOCH FROM (sales_start_at - app_now())) - 600))::float8 AS drift, (SELECT COUNT(*) FROM tickets t WHERE t.event_id IN (SELECT id FROM events WHERE sales_start_at > app_now()))::int AS sold
       FROM events WHERE status = 'on_sale' AND sales_start_at > app_now()`,
    );
    const row = r.rows[0] as { n: number; drift: number; sold: number };
    expect(row.n).toBeGreaterThanOrEqual(3);
    expect(row.drift).toBeLessThan(120);
    expect(row.sold).toBe(0);
  });

  it('every state is represented', async () => {
    const r = await tdb.pool.query(`SELECT status::text FROM events GROUP BY status`);
    const statuses = r.rows.map((x: { status: string }) => x.status).sort();
    expect(statuses).toEqual(expect.arrayContaining(['cancelled', 'draft', 'finished', 'on_sale', 'paid_out', 'rescheduled', 'sold_out']));
  });

  it('ledger is balanced, balances equal entry sums, rollups equal raw data', async () => {
    await expectLedgerClean(tdb.pool);
    const r = await tdb.pool.query(
      `SELECT (SELECT SUM(gross + fees - refunds) FROM sales_hourly)::bigint::text AS rolled,
              (SELECT COALESCE(SUM(-amount), 0) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code LIKE 'organizer_payable:%' AND e.txn_id IN (SELECT id FROM ledger_transactions WHERE kind IN ('payment','refund')))::text AS payable,
              (SELECT COALESCE(SUM(-amount), 0) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code = 'service_fee_revenue')::text AS fees`,
    );
    const row = r.rows[0] as { rolled: string; payable: string; fees: string };
    expect(BigInt(row.rolled)).toBe(BigInt(row.payable) + BigInt(row.fees));
  });

  it('payouts follow the rule payout = sales - refunds - commission and settle the organizer liability', async () => {
    const bad = await scalar(`SELECT COUNT(*) AS n FROM payouts WHERE commission <> ((sales - refunds) * 8) / 100 OR amount <> sales - refunds - commission`);
    expect(bad).toBe(0);
    expect(await scalar(`SELECT COUNT(*) AS n FROM payouts`)).toBe(await scalar(`SELECT COUNT(*) AS n FROM events WHERE status = 'paid_out'`));
  });

  it('counters agree with tickets and seats; nothing is oversold or double sold', async () => {
    expect(await scalar(`SELECT COUNT(*) AS n FROM events e WHERE e.sold_count <> (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status = 'valid')`)).toBe(0);
    expect(await scalar(`SELECT COUNT(*) AS n FROM events WHERE sold_count > capacity`)).toBe(0);
    expect(await scalar(`SELECT COUNT(*) AS n FROM events e WHERE (SELECT COUNT(*) FROM event_seats s WHERE s.event_id = e.id AND s.status = 'sold') <> (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status = 'valid' AND t.seat_id IS NOT NULL)`)).toBe(0);
    expect(await scalar(`SELECT COUNT(*) AS n FROM events WHERE status = 'sold_out' AND sold_count <> capacity`)).toBe(0);
  });

  it('order totals, payments and items agree', async () => {
    expect(await scalar(`SELECT COUNT(*) AS n FROM orders o WHERE o.total <> (SELECT SUM(price - discount + fee) FROM order_items i WHERE i.order_id = o.id)`)).toBe(0);
    expect(await scalar(`SELECT COUNT(*) AS n FROM orders o JOIN payments p ON p.order_id = o.id WHERE p.amount <> o.total OR p.status <> 'succeeded'`)).toBe(0);
    expect(await scalar(`SELECT COUNT(*) AS n FROM order_items WHERE fee < 2000`)).toBe(0);
  });

  it('service fee follows the 5% / 20 UAH rule on every seeded item', async () => {
    expect(await scalar(`SELECT COUNT(*) AS n FROM order_items WHERE fee <> GREATEST(2000, (price * 5 + 50) / 100)`)).toBe(0);
  });

  it('bulk load skipped FK checks, so verify every foreign key by hand', async () => {
    const fks = await tdb.pool.query(
      `SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
              (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols,
              (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_cols
       FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
    );
    expect(fks.rows.length).toBeGreaterThan(30);
    for (const fk of fks.rows as { conname: string; child: string; parent: string; child_cols: string[]; parent_cols: string[] }[]) {
      const on = fk.child_cols.map((c, i) => `p."${fk.parent_cols[i]}" = c."${c}"`).join(' AND ');
      const notNull = fk.child_cols.map((c) => `c."${c}" IS NOT NULL`).join(' AND ');
      const orphans = await scalar(`SELECT COUNT(*) AS n FROM ${fk.child} c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE ${on})`);
      expect(orphans, fk.conname).toBe(0);
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    const before = await scalar(`SELECT COUNT(*) AS n FROM ledger_entries`);
    const again = await runSeed(tdb.pool, SMALL_SEED, 'x');
    expect(again).toEqual({ skipped: true });
    expect(await scalar(`SELECT COUNT(*) AS n FROM ledger_entries`)).toBe(before);
  });

  it('seed accounts exist for every role', async () => {
    const r = await tdb.pool.query(`SELECT email, role::text FROM users WHERE email IN ('buyer1@example.test', 'finance1@example.test', 'organizer1@example.test', 'scanner1@example.test') ORDER BY email`);
    expect(r.rows).toEqual([
      { email: 'buyer1@example.test', role: 'buyer' },
      { email: 'finance1@example.test', role: 'finance' },
      { email: 'organizer1@example.test', role: 'organizer' },
      { email: 'scanner1@example.test', role: 'scanner' },
    ]);
  });
});
