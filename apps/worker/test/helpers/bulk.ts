import type { Pool } from 'pg';
import { createWorld, type World } from '@ticketing/testkit';

export interface Bulk {
  readonly world: World;
  readonly orderIds: readonly string[];
  readonly userIds: readonly string[];
}

/** `count` paid orders of `perOrder` tickets each, created set-based (fast), with real payments and ledger postings. */
export const bulkPaidOrders = async (pool: Pool, count: number, perOrder = 1): Promise<Bulk> => {
  const world = await createWorld(pool, { seats: count * perOrder + 5 });
  const users = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, role) SELECT gen_random_uuid() || '@example.test', 'x', 'Bulk', 'buyer' FROM generate_series(1, $1::int) RETURNING id`,
    [count],
  );
  const userIds = users.rows.map((r) => r.id);
  const orders = await pool.query<{ id: string; user_id: string }>(
    `INSERT INTO orders (user_id, event_id, status, hold_expires_at, subtotal, fee, total, paid_at)
     SELECT u, $2, 'holding', app_now() + interval '10 minutes', 100000 * $3, 5000 * $3, 105000 * $3, NULL FROM unnest($1::uuid[]) AS u RETURNING id, user_id`,
    [userIds, world.eventId, perOrder],
  );
  const numbered = orders.rows.map((o, i) => ({ ...o, base: i * perOrder }));
  await pool.query(
    `INSERT INTO order_items (order_id, event_id, zone_id, tier_id, seat_id, price, fee)
     SELECT o.id, $2, $3, $4, (SELECT id FROM seats WHERE zone_id = $3 ORDER BY id OFFSET o.base + k LIMIT 1), 100000, 5000
     FROM unnest($1::uuid[], $5::int[]) AS o(id, base) CROSS JOIN generate_series(0, $6::int - 1) k`,
    [numbered.map((o) => o.id), world.eventId, world.zoneId, world.tierId, numbered.map((o) => o.base), perOrder],
  );
  await pool.query(`UPDATE event_seats es SET status = 'held', hold_order_id = i.order_id, hold_expires_at = app_now() + interval '10 minutes' FROM order_items i WHERE i.event_id = es.event_id AND i.seat_id = es.seat_id`);
  await pool.query(`UPDATE orders SET status = 'awaiting_payment' WHERE event_id = $1`, [world.eventId]);
  await pool.query(`INSERT INTO payments (order_id, amount, status, provider_payment_id) SELECT id, total, 'pending', 'pay_' || replace(id::text, '-', '') FROM orders WHERE event_id = $1`, [world.eventId]);
  // Confirm every payment with the real domain function, so tickets, seats and ledger are exactly what production produces.
  const { applyPaymentSucceeded } = await import('@ticketing/platform');
  const payments = await pool.query<{ id: string }>(`SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.event_id = $1`, [world.eventId]);
  for (const p of payments.rows) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await applyPaymentSucceeded(c, p.id, 2);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
  return { world, orderIds: orders.rows.map((o) => o.id), userIds };
};
