import type { PoolClient } from 'pg';
import { enqueue, history, lockOrder, type LockedOrder } from './orders.js';
import { createRefund } from './refund-core.js';

export type ConfirmOutcome = 'paid' | 'refunding' | 'already' | 'unknown';

interface ItemRow {
  id: string;
  seat_id: string | null;
  zone_id: string;
  price: number;
  discount: number;
  fee: number;
}

/** Hold still valid: seats are ours, turn them into sold seats and issue the tickets. */
const issueTickets = async (tx: PoolClient, order: LockedOrder, items: readonly ItemRow[]): Promise<void> => {
  await tx.query(`UPDATE orders SET status = 'paid', paid_at = app_now() WHERE id = $1`, [order.id]);
  const sold = await tx.query<{ seat_id: string }>(
    `UPDATE event_seats SET status = 'sold', hold_order_id = NULL, hold_expires_at = NULL WHERE event_id = $1 AND (hold_order_id = $2 OR seat_id = ANY($3::bigint[])) AND status IN ('held', 'sold') RETURNING seat_id`,
    [order.event_id, order.id, items.flatMap((i) => (i.seat_id === null ? [] : [Number(i.seat_id)]))],
  );
  const general = new Map<string, number>();
  for (const i of items) if (i.seat_id === null) general.set(i.zone_id, (general.get(i.zone_id) ?? 0) + 1);
  for (const [zoneId, n] of [...general].sort(([a], [b]) => (a < b ? -1 : 1))) {
    await tx.query(`UPDATE event_zones SET held = GREATEST(0, held - $3), sold = sold + $3 WHERE event_id = $1 AND zone_id = $2`, [order.event_id, zoneId, n]);
  }
  await tx.query(
    `INSERT INTO tickets (order_id, order_item_id, event_id, owner_id, seat_id, zone_id) SELECT $1, i.id, $2, $3, i.seat_id, i.zone_id FROM order_items i WHERE i.order_id = $1`,
    [order.id, order.event_id, order.user_id],
  );
  await tx.query(`UPDATE events SET sold_count = sold_count + $2 WHERE id = $1`, [order.event_id, items.length]);
  await tx.query(`UPDATE events SET status = 'sold_out' WHERE id = $1 AND status = 'on_sale' AND sold_count + blocked_count >= capacity`, [order.event_id]);
  await tx.query(`UPDATE queue_entries SET status = 'done', paid = true, finished_at = app_now() WHERE event_id = $1 AND user_id = $2 AND status IN ('admitted', 'selecting')`, [order.event_id, order.user_id]);
  await tx.query(`SELECT emit_seat_events($1, $2::bigint[], 'sold', NULL)`, [order.event_id, sold.rows.map((r) => Number(r.seat_id)).sort((a, b) => a - b)]);
  for (const zoneId of general.keys()) await tx.query(`SELECT emit_zone_event($1, $2)`, [order.event_id, zoneId]);
  await history(tx, order.id, 'system', null, 'paid', { total: order.total });
  await history(tx, order.id, 'system', null, 'tickets_issued', { count: items.length });
  await enqueue(tx, 'email', `email:tickets:${order.id}`, { template: 'tickets', orderId: order.id, userId: order.user_id });
};

/** The hold ran out (or the event changed) before the payment arrived: take the places again if nobody else has them. */
const reacquire = async (tx: PoolClient, order: LockedOrder, items: readonly ItemRow[]): Promise<boolean> => {
  const ev = (await tx.query<{ ok: boolean }>(`SELECT (status IN ('on_sale', 'rescheduled') AND starts_at > app_now()) AS ok FROM events WHERE id = $1`, [order.event_id])).rows[0];
  if (!ev?.ok) return false;
  const seatIds = items.flatMap((i) => (i.seat_id === null ? [] : [Number(i.seat_id)])).sort((a, b) => a - b);
  await tx.query('SAVEPOINT reacquire');
  const fail = async (): Promise<boolean> => {
    await tx.query('ROLLBACK TO SAVEPOINT reacquire');
    return false;
  };
  if (seatIds.length > 0) {
    await tx.query(`SELECT 1 FROM event_seats WHERE event_id = $1 AND seat_id = ANY($2::bigint[]) ORDER BY seat_id FOR UPDATE`, [order.event_id, seatIds]);
    const got = await tx.query(
      `UPDATE event_seats SET status = 'held', hold_order_id = $3, hold_expires_at = app_now() + interval '1 minute'
       WHERE event_id = $1 AND seat_id = ANY($2::bigint[]) AND (status = 'free' OR (status = 'held' AND hold_expires_at <= app_now()))
         AND (reserved_for_offer_id IS NULL OR NOT EXISTS (SELECT 1 FROM waitlist_offers w WHERE w.id = reserved_for_offer_id AND w.status = 'active' AND w.expires_at > app_now() AND w.user_id <> $4))
       RETURNING seat_id`,
      [order.event_id, seatIds, order.id, order.user_id],
    );
    if (got.rowCount !== seatIds.length) return fail();
  }
  const general = new Map<string, number>();
  for (const i of items) if (i.seat_id === null) general.set(i.zone_id, (general.get(i.zone_id) ?? 0) + 1);
  for (const [zoneId, n] of [...general].sort(([a], [b]) => (a < b ? -1 : 1))) {
    await tx.query(`SELECT release_order(o.id) FROM orders o WHERE o.event_id = $1 AND o.status IN ('holding', 'awaiting_payment') AND o.hold_expires_at <= app_now() AND o.id <> $2 AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.zone_id = $3 AND i.seat_id IS NULL) LIMIT 500`, [order.event_id, order.id, zoneId]);
    const z = (await tx.query<{ free: number }>(
      `SELECT ez.capacity - ez.sold - ez.held - (SELECT COUNT(*) FROM waitlist_offers w WHERE w.event_id = ez.event_id AND w.zone_id = ez.zone_id AND w.status = 'active' AND w.expires_at > app_now() AND w.user_id <> $3)::int AS free
       FROM event_zones ez WHERE ez.event_id = $1 AND ez.zone_id = $2 FOR UPDATE`,
      [order.event_id, zoneId, order.user_id],
    )).rows[0];
    if (!z || z.free < n) return fail();
    await tx.query(`UPDATE event_zones SET held = held + $3 WHERE event_id = $1 AND zone_id = $2`, [order.event_id, zoneId, n]);
  }
  if (order.promo_id && !order.promo_held) {
    const promo = await tx.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND used_count < usage_limit RETURNING id`, [order.promo_id]);
    if (promo.rowCount === 0) return fail();
  }
  await tx.query(`UPDATE orders SET promo_held = (promo_id IS NOT NULL) WHERE id = $1`, [order.id]);
  await tx.query('RELEASE SAVEPOINT reacquire');
  return true;
};

/**
 * The provider says the payment succeeded. Exactly-once: the payment row is locked and a succeeded payment is never
 * processed again. A payment that arrives after the hold expired follows the "payment after hold" rule: tickets if the
 * places can be taken again, otherwise a full automatic refund.
 */
export const applyPaymentSucceeded = async (tx: PoolClient, paymentId: string, seq: number | null): Promise<ConfirmOutcome> => {
  const payment = (await tx.query<{ id: string; order_id: string; status: string; amount: number }>(`SELECT id, order_id, status, amount FROM payments WHERE id = $1 FOR UPDATE`, [paymentId])).rows[0];
  if (!payment) return 'unknown';
  if (payment.status === 'succeeded') return 'already';
  const order = await lockOrder(tx, payment.order_id);
  if (!order) return 'unknown';
  await tx.query(`UPDATE payments SET status = 'succeeded', succeeded_at = app_now(), last_event_seq = GREATEST(last_event_seq, $2), updated_at = app_now() WHERE id = $1`, [paymentId, seq ?? 0]);
  const items = (await tx.query<ItemRow>(`SELECT id, seat_id, zone_id, price, discount, fee FROM order_items WHERE order_id = $1 ORDER BY id`, [order.id])).rows;

  const onTime = order.status === 'awaiting_payment' && !order.expired;
  if (onTime) {
    const live = (await tx.query<{ ok: boolean }>(`SELECT status IN ('on_sale', 'sold_out', 'rescheduled') AS ok FROM events WHERE id = $1`, [order.event_id])).rows[0];
    if (live?.ok) {
      await issueTickets(tx, order, items);
      await tx.query(`SELECT post_payment($1)`, [paymentId]);
      return 'paid';
    }
  }
  await tx.query(`SELECT release_order($1, true)`, [order.id]);
  if (order.status !== 'paid' && order.status !== 'refunded' && (await reacquire(tx, order, items))) {
    await history(tx, order.id, 'system', null, 'late_payment_accepted', {});
    await issueTickets(tx, { ...order, status: 'expired' }, items);
    await tx.query(`SELECT post_payment($1)`, [paymentId]);
    return 'paid';
  }
  await tx.query(`SELECT post_payment($1)`, [paymentId]);
  await tx.query(`UPDATE orders SET paid_at = COALESCE(paid_at, app_now()) WHERE id = $1`, [order.id]); // money was received, even though no tickets follow
  await history(tx, order.id, 'system', null, 'late_payment_refund', { reason: 'places no longer available' });
  await createRefund(tx, {
    orderId: order.id, kind: 'late_payment', reason: 'Payment arrived after the places were released', requestedBy: null,
    items: items.map((i) => ({ itemId: i.id, price: i.price - i.discount, fee: i.fee })), releaseTickets: false,
  });
  return 'refunding';
};

/** A failed payment never overrides a successful one, and a stale event (lower sequence) never overrides a newer one. */
export const applyPaymentFailed = async (tx: PoolClient, paymentId: string, seq: number): Promise<void> => {
  await tx.query(
    `UPDATE payments SET status = 'failed', last_event_seq = $2, updated_at = app_now() WHERE id = $1 AND status <> 'succeeded' AND last_event_seq < $2`,
    [paymentId, seq],
  );
};
