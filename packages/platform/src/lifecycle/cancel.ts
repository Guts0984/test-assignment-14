import type { PoolClient } from 'pg';
import { EVENT_TRANSITIONS, canTransition, type EventStatus } from '@ticketing/shared';
import { enqueue, lockEvent } from '../payments/orders.js';

export type CancelOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'already_cancelled' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_allowed'; readonly status: EventStatus };

/**
 * Cancels an event. Everything that matters happens in ONE transaction under the exclusive event lock: sales,
 * refunds and transfers stop at once (they take the same lock in shared mode), unpaid holds are released, and a
 * refund row plus a durable task is created for every paid order in a single set-based statement. The refunds
 * are executed later by workers; calling this again finds the event cancelled and changes nothing.
 * `organizerId` null skips the ownership check (system callers).
 */
export const cancelEventInTx = async (tx: PoolClient, eventId: string, organizerId: string | null): Promise<CancelOutcome> => {
  const peek = await tx.query(`SELECT 1 FROM events WHERE id = $1 AND ($2::uuid IS NULL OR organizer_id = $2)`, [eventId, organizerId]);
  if (peek.rowCount === 0) return { kind: 'not_found' };
  await lockEvent(tx, eventId, false);
  const ev = (await tx.query<{ status: EventStatus }>(`SELECT status FROM events WHERE id = $1 FOR UPDATE`, [eventId])).rows[0];
  if (!ev) return { kind: 'not_found' };
  if (ev.status === 'cancelled') return { kind: 'already_cancelled' };
  if (!canTransition(EVENT_TRANSITIONS, ev.status, 'cancelled', 'organizer')) return { kind: 'not_allowed', status: ev.status };

  await tx.query(`UPDATE events SET status = 'cancelled', cancelled_at = app_now() WHERE id = $1`, [eventId]);
  await tx.query(`SELECT release_order(o.id, true) FROM orders o WHERE o.event_id = $1 AND o.status IN ('holding', 'awaiting_payment')`, [eventId]);
  await tx.query(`UPDATE waitlist_offers SET status = 'cancelled' WHERE event_id = $1 AND status = 'active'`, [eventId]);
  // The statement below builds ~60k refund items from rows that cannot violate the rules; the per-row guard is skipped
  // for this transaction only and the order-level sums are verified right afterwards.
  await tx.query(`SET LOCAL app.trusted_bulk = 'on'`);
  await tx.query(
    `WITH remaining AS (
       SELECT i.id AS item_id, i.order_id, (i.price - i.discount) AS price, i.fee FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.event_id = $1 AND o.status IN ('paid', 'partially_refunded') AND NOT EXISTS (SELECT 1 FROM refund_items r WHERE r.order_item_id = i.id AND r.active)
     ), per_order AS (SELECT order_id, SUM(price)::int AS price, SUM(fee)::int AS fee FROM remaining GROUP BY order_id),
     new_refunds AS (
       INSERT INTO refunds (order_id, kind, price_amount, fee_amount, amount, reason) SELECT order_id, 'event_cancelled', price, fee, price + fee, 'Event cancelled' FROM per_order RETURNING id, order_id
     ), items AS (
       INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) SELECT n.id, r.item_id, r.price, r.fee FROM remaining r JOIN new_refunds n ON n.order_id = r.order_id RETURNING 1
     ), refund_tasks AS (
       INSERT INTO tasks (kind, dedupe_key, payload) SELECT 'refund_execute', 'refund:' || id, jsonb_build_object('refundId', id) FROM new_refunds ON CONFLICT (dedupe_key) DO NOTHING RETURNING 1
     ), mail_tasks AS (
       INSERT INTO tasks (kind, dedupe_key, payload) SELECT 'email', 'email:cancel:' || order_id, jsonb_build_object('template', 'event_cancelled', 'orderId', order_id, 'refundId', id) FROM new_refunds ON CONFLICT (dedupe_key) DO NOTHING RETURNING 1
     ), tickets_done AS (UPDATE tickets SET status = 'refunded' WHERE order_item_id IN (SELECT item_id FROM remaining) RETURNING 1)
     UPDATE orders SET status = 'refunded' WHERE id IN (SELECT order_id FROM per_order)`,
    [eventId],
  );
  const over = await tx.query(
    `SELECT 1 FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1 AND ri.active GROUP BY o.id, o.total HAVING SUM(ri.price_amount + ri.fee_amount) > o.total LIMIT 1`,
    [eventId],
  );
  if (over.rowCount === 1) throw new Error('mass cancellation would refund more than was paid');
  await enqueue(tx, 'mass_cancel_notice', `mass_cancel:${eventId}`, { eventId });
  return { kind: 'cancelled' };
};
