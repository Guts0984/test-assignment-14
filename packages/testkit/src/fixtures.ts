import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type Db = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface World {
  readonly organizerId: string;
  readonly buyerId: string;
  readonly venueId: string;
  readonly zoneId: string;
  readonly eventId: string;
  readonly tierId: string;
  readonly seatIds: readonly number[];
}

const one = async <T>(db: Db, sql: string, params: readonly unknown[] = []): Promise<T> => {
  const res = await db.query(sql, [...params]);
  const row = res.rows[0] as T | undefined;
  if (row === undefined) throw new Error(`no row returned for: ${sql}`);
  return row;
};

export const insertUser = async (db: Db, role: 'buyer' | 'organizer' | 'scanner' | 'finance' = 'buyer'): Promise<string> =>
  (await one<{ id: string }>(db, `INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Test', $2) RETURNING id`, [`${randomUUID()}@example.test`, role])).id;

/** Organizer + buyer + a venue with one seated zone, an on_sale event and priced seats. */
export const createWorld = async (db: Db, opts: { seats?: number; price?: number; limit?: number } = {}): Promise<World> => {
  const seats = opts.seats ?? 10;
  const price = opts.price ?? 100_000;
  const organizerId = await insertUser(db, 'organizer');
  const buyerId = await insertUser(db);
  const venueId = (await one<{ id: string }>(db, `INSERT INTO venues (organizer_id, name, city, capacity) VALUES ($1, 'Hall', 'Kyiv', $2) RETURNING id`, [organizerId, seats])).id;
  const zoneId = (await one<{ id: string }>(db, `INSERT INTO zones (venue_id, key, name, kind, capacity) VALUES ($1, 'A', 'Stalls', 'seated', $2) RETURNING id`, [venueId, seats])).id;
  await db.query(
    `INSERT INTO seats (venue_id, zone_id, row_label, number, x, y) SELECT $1, $2, '1', n, n, 0 FROM generate_series(1, $3::int) n`,
    [venueId, zoneId, seats],
  );
  const seatIds = (await db.query(`SELECT id FROM seats WHERE zone_id = $1 ORDER BY id`, [zoneId])).rows.map((r: { id: string }) => Number(r.id));
  const eventId = (
    await one<{ id: string }>(
      db,
      `INSERT INTO events (organizer_id, venue_id, title, city, category, starts_at, sales_start_at, status, capacity, per_person_limit)
       VALUES ($1, $2, 'Concert', 'Kyiv', 'rock', app_now() + interval '30 days', app_now() - interval '1 day', 'on_sale', $3, $4) RETURNING id`,
      [organizerId, venueId, seats, opts.limit ?? 6],
    )
  ).id;
  const tierId = (await one<{ id: string }>(db, `INSERT INTO price_tiers (event_id, name, price) VALUES ($1, 'Std', $2) RETURNING id`, [eventId, price])).id;
  await db.query(`INSERT INTO event_zones (event_id, zone_id, tier_id, capacity) VALUES ($1, $2, $3, $4)`, [eventId, zoneId, tierId, seats]);
  await db.query(`INSERT INTO event_seats (event_id, seat_id, zone_id, tier_id) SELECT $1, id, $2, $3 FROM seats WHERE zone_id = $2`, [eventId, zoneId, tierId]);
  return { organizerId, buyerId, venueId, zoneId, eventId, tierId, seatIds };
};

export interface PaidOrder {
  readonly orderId: string;
  readonly paymentId: string;
  readonly itemIds: readonly string[];
  readonly price: number;
  readonly fee: number;
}

/** An awaiting_payment order for the given seats with a pending payment row (prices stored as the api would). */
export const createAwaitingOrder = async (db: Db, w: World, seatIdxs: readonly number[], price = 100_000, fee = 5_000): Promise<PaidOrder> => {
  const total = (price + fee) * seatIdxs.length;
  const orderId = (
    await one<{ id: string }>(
      db,
      `INSERT INTO orders (user_id, event_id, status, hold_expires_at, subtotal, discount, fee, total)
       VALUES ($1, $2, 'holding', app_now() + interval '10 minutes', $3, 0, $4, $5) RETURNING id`,
      [w.buyerId, w.eventId, price * seatIdxs.length, fee * seatIdxs.length, total],
    )
  ).id;
  const itemIds: string[] = [];
  for (const idx of seatIdxs) {
    const seatId = w.seatIds[idx];
    itemIds.push(
      (await one<{ id: string }>(db, `INSERT INTO order_items (order_id, event_id, zone_id, tier_id, seat_id, price, fee) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [orderId, w.eventId, w.zoneId, w.tierId, seatId, price, fee])).id,
    );
    await db.query(
      `UPDATE event_seats SET status = 'held', hold_order_id = $1, hold_expires_at = app_now() + interval '10 minutes' WHERE event_id = $2 AND seat_id = $3`,
      [orderId, w.eventId, seatId],
    );
  }
  await db.query(`UPDATE orders SET status = 'awaiting_payment' WHERE id = $1`, [orderId]);
  const paymentId = (await one<{ id: string }>(db, `INSERT INTO payments (order_id, amount, status, provider_payment_id) VALUES ($1, $2, 'pending', $3) RETURNING id`, [orderId, total, `pay_${randomUUID()}`])).id;
  return { orderId, paymentId, itemIds, price, fee };
};

/** Marks the order paid and posts the payment to the ledger (what the payment flow does in one transaction). */
export const payOrder = async (db: Db, order: PaidOrder): Promise<void> => {
  await db.query(`UPDATE payments SET status = 'succeeded', succeeded_at = app_now() WHERE id = $1`, [order.paymentId]);
  await db.query(`UPDATE orders SET status = 'paid', paid_at = app_now() WHERE id = $1`, [order.orderId]);
  await db.query(`SELECT post_payment($1)`, [order.paymentId]);
};

export interface LedgerReport {
  readonly total: bigint;
  readonly unbalancedTransactions: number;
  readonly balanceMismatches: number;
  readonly dailyMismatches: number;
}

/** The reconciliation checks, runnable after every scenario. */
export const ledgerReport = async (db: Db): Promise<LedgerReport> => {
  const row = await one<{ total: string; unbalanced: string; balances: string; daily: string }>(
    db,
    `SELECT
       (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries)::text AS total,
       (SELECT COUNT(*) FROM (SELECT txn_id FROM ledger_entries GROUP BY txn_id HAVING SUM(amount) <> 0) x)::text AS unbalanced,
       (SELECT COUNT(*) FROM accounts a WHERE a.balance <> COALESCE((SELECT SUM(amount) FROM ledger_entries e WHERE e.account_id = a.id), 0))::text AS balances,
       (SELECT COUNT(*) FROM ledger_daily d WHERE d.debit - d.credit <> COALESCE((SELECT SUM(amount) FROM ledger_entries e WHERE e.account_id = d.account_id AND (e.created_at AT TIME ZONE 'UTC')::date = d.day), 0))::text AS daily`,
  );
  return { total: BigInt(row.total), unbalancedTransactions: Number(row.unbalanced), balanceMismatches: Number(row.balances), dailyMismatches: Number(row.daily) };
};

export const expectLedgerClean = async (db: Db): Promise<LedgerReport> => {
  const report = await ledgerReport(db);
  if (report.total !== 0n || report.unbalancedTransactions !== 0 || report.balanceMismatches !== 0 || report.dailyMismatches !== 0) {
    throw new Error(`ledger invariant broken: ${JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  }
  return report;
};

/** Bulk-creates buyers quickly (one statement). */
export const insertUsers = async (db: Db, count: number): Promise<readonly string[]> => {
  const res = await db.query(
    `INSERT INTO users (email, password_hash, display_name, role)
     SELECT gen_random_uuid() || '@example.test', 'x', 'Bulk', 'buyer' FROM generate_series(1, $1::int) RETURNING id`,
    [count],
  );
  return res.rows.map((r: { id: string }) => r.id);
};

/** Moves the database clock (`app_now()`) forward by `ms` relative to the real clock. */
export const setClockOffset = async (db: Db, ms: number): Promise<void> => {
  await db.query(`UPDATE test_clock SET offset_ms = $1`, [ms]);
};
