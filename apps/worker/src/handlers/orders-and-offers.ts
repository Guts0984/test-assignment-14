import type { TaskHandler } from '@ticketing/platform';
import { payloadString, type HandlerDeps } from './deps.js';

/**
 * Releases an unpaid order once its hold is over. The decision belongs to the database clock: if the task fires early
 * (clock moved, delayed job promoted) it simply asks to run again when the hold really ends.
 */
export const holdExpire = (d: HandlerDeps): TaskHandler => async (task) => {
  const orderId = payloadString(task, 'orderId');
  const o = (await d.pool.query<{ event_id: string; user_id: string; status: string; remaining_ms: number | null }>(
    `SELECT event_id, user_id, status::text AS status, (EXTRACT(EPOCH FROM (hold_expires_at - app_now())) * 1000)::float8 AS remaining_ms FROM orders WHERE id = $1`,
    [orderId],
  )).rows[0];
  if (!o || !['holding', 'awaiting_payment'].includes(o.status)) return undefined;
  if (o.remaining_ms !== null && o.remaining_ms > 0) return { again: Math.ceil(o.remaining_ms) + 50 };
  const released = (await d.pool.query<{ r: boolean }>(`SELECT release_order($1) AS r`, [orderId])).rows[0]?.r;
  if (released) {
    d.rt.seatsChanged(o.event_id);
    d.rt.toUser(o.user_id, 'order.updated', { orderId, status: 'expired' });
  }
  return undefined;
};

/** A waitlist offer ran out: expire it and offer the seat to the next person. */
export const waitlistExpire = (d: HandlerDeps): TaskHandler => async (task) => {
  const eventId = payloadString(task, 'eventId');
  const offerId = payloadString(task, 'offerId');
  const o = (await d.pool.query<{ remaining_ms: number }>(`SELECT (EXTRACT(EPOCH FROM (expires_at - app_now())) * 1000)::float8 AS remaining_ms FROM waitlist_offers WHERE id = $1 AND status = 'active'`, [offerId])).rows[0];
  if (o && o.remaining_ms > 0) return { again: Math.ceil(o.remaining_ms) + 50 };
  await d.pool.query(`SELECT waitlist_offer_next($1)`, [eventId]);
  d.rt.seatsChanged(eventId);
  return undefined;
};
