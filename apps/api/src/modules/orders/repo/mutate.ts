import type { PoolClient } from 'pg';
import { appError, err, ok, type Result } from '../../../common/result.js';
import { repriceOrder } from './reprice.js';

interface OwnedOrder {
  id: string;
  event_id: string;
  status: string;
  expired: boolean;
  promo_id: string | null;
  promo_held: boolean;
}

/** Locks the user's own order. Foreign or missing orders both come back as null (no existence leak). */
const lockOwned = async (tx: PoolClient, orderId: string, userId: string): Promise<OwnedOrder | undefined> =>
  (await tx.query<OwnedOrder>(
    `SELECT id, event_id, status, (hold_expires_at <= app_now()) AS expired, promo_id, promo_held FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [orderId, userId],
  )).rows[0];

/** Editable = still `holding` and not expired. An expired hold is released on the spot (server clock decides). */
const requireEditable = async (tx: PoolClient, order: OwnedOrder | undefined): Promise<Result<OwnedOrder>> => {
  if (!order) return err(appError('NOT_FOUND', 'Order not found'));
  if (order.status === 'holding' && order.expired) {
    await tx.query(`SELECT release_order($1)`, [order.id]);
    return err(appError('HOLD_EXPIRED', 'The hold on these seats has expired'));
  }
  if (order.status !== 'holding') return err(appError('CONFLICT', `Order is ${order.status} and can no longer be changed`));
  return ok(order);
};

export const removeItem = async (tx: PoolClient, orderId: string, itemId: string, userId: string): Promise<Result<true>> => {
  const order = await requireEditable(tx, await lockOwned(tx, orderId, userId));
  if (!order.ok) return order;
  const item = (await tx.query<{ id: string; seat_id: string | null; zone_id: string }>(`DELETE FROM order_items WHERE id = $1 AND order_id = $2 RETURNING id, seat_id, zone_id`, [itemId, orderId])).rows[0];
  if (!item) return err(appError('NOT_FOUND', 'Item not found'));
  if (item.seat_id !== null) {
    await tx.query(`UPDATE event_seats SET status = 'free', hold_order_id = NULL, hold_expires_at = NULL WHERE event_id = $1 AND seat_id = $2 AND hold_order_id = $3`, [order.value.event_id, item.seat_id, orderId]);
    await tx.query(`SELECT emit_seat_events($1, ARRAY[$2]::bigint[], 'free', NULL)`, [order.value.event_id, item.seat_id]);
  } else {
    await tx.query(`UPDATE event_zones SET held = GREATEST(0, held - 1) WHERE event_id = $1 AND zone_id = $2`, [order.value.event_id, item.zone_id]);
    await tx.query(`SELECT emit_zone_event($1, $2)`, [order.value.event_id, item.zone_id]);
  }
  await repriceOrder(tx, orderId);
  await tx.query(`INSERT INTO order_history (order_id, actor_id, actor_role, type, data) VALUES ($1, $2, 'buyer', 'item_removed', $3::jsonb)`, [orderId, userId, JSON.stringify({ itemId, seatId: item.seat_id })]);
  return ok(true);
};

export const abandonOrder = async (tx: PoolClient, orderId: string, userId: string): Promise<Result<true>> => {
  const order = await lockOwned(tx, orderId, userId);
  if (!order) return err(appError('NOT_FOUND', 'Order not found'));
  if (order.status !== 'holding') return err(appError('CONFLICT', `Order is ${order.status} and cannot be released`));
  await tx.query(`SELECT release_order($1, true)`, [orderId]);
  return ok(true);
};

/**
 * Applies a promo code. The usage counter is incremented by one conditional UPDATE, so under any concurrency exactly
 * `usage_limit` applications succeed. If the limit looks reached, holds that already expired are released first
 * (their promo use is returned) and the update is retried once.
 */
export const applyPromo = async (tx: PoolClient, orderId: string, userId: string, code: string): Promise<Result<true>> => {
  const order = await requireEditable(tx, await lockOwned(tx, orderId, userId));
  if (!order.ok) return order;
  if (order.value.promo_held) return err(appError('CONFLICT', 'This order already has a promo code'));
  const promo = (await tx.query<{ id: string; event_id: string | null; organizer_id: string }>(
    `SELECT p.id, p.event_id, p.organizer_id FROM promo_codes p JOIN events e ON e.id = $2 WHERE p.code = $1 AND p.organizer_id = e.organizer_id AND (p.event_id IS NULL OR p.event_id = e.id)`,
    [code, order.value.event_id],
  )).rows[0];
  if (!promo) return err(appError('PROMO_INVALID', 'Promo code is not valid for this event'));
  const use = () => tx.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND used_count < usage_limit RETURNING id`, [promo.id]);
  let used = await use();
  if (used.rowCount === 0) {
    await tx.query(
      `SELECT release_order(o.id) FROM orders o WHERE o.promo_id = $1 AND o.promo_held AND o.status IN ('holding', 'awaiting_payment') AND o.hold_expires_at <= app_now() AND o.id <> $2 ORDER BY o.hold_expires_at LIMIT 500`,
      [promo.id, orderId],
    );
    used = await use();
  }
  if (used.rowCount === 0) return err(appError('PROMO_INVALID', 'This promo code has reached its usage limit'));
  await tx.query(`UPDATE orders SET promo_id = $2, promo_held = true WHERE id = $1`, [orderId, promo.id]);
  await repriceOrder(tx, orderId);
  await tx.query(`INSERT INTO order_history (order_id, actor_id, actor_role, type, data) VALUES ($1, $2, 'buyer', 'promo_applied', $3::jsonb)`, [orderId, userId, JSON.stringify({ code })]);
  return ok(true);
};

/** Removing a promo from an unpaid order returns the use. */
export const removePromo = async (tx: PoolClient, orderId: string, userId: string): Promise<Result<true>> => {
  const order = await requireEditable(tx, await lockOwned(tx, orderId, userId));
  if (!order.ok) return order;
  if (!order.value.promo_held || !order.value.promo_id) return err(appError('CONFLICT', 'The order has no promo code'));
  await tx.query(`UPDATE promo_codes SET used_count = used_count - 1 WHERE id = $1 AND used_count > 0`, [order.value.promo_id]);
  await tx.query(`UPDATE orders SET promo_id = NULL, promo_held = false WHERE id = $1`, [orderId]);
  await repriceOrder(tx, orderId);
  await tx.query(`INSERT INTO order_history (order_id, actor_id, actor_role, type, data) VALUES ($1, $2, 'buyer', 'promo_removed', '{}')`, [orderId, userId]);
  return ok(true);
};
