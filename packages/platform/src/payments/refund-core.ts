import type { PoolClient } from 'pg';
import { enqueue, history } from './orders.js';

export interface RefundItemInput {
  readonly itemId: string;
  /** Price actually paid for the ticket (after promo). */
  readonly price: number;
  readonly fee: number;
}

export interface NewRefund {
  readonly orderId: string;
  readonly kind: 'user' | 'finance' | 'event_cancelled' | 'late_payment';
  readonly reason: string | null;
  readonly requestedBy: string | null;
  readonly items: readonly RefundItemInput[];
  /** True when the tickets exist and must become invalid, their places free again. */
  readonly releaseTickets: boolean;
}

/**
 * Records a refund of some tickets of an order. The caller has locked the order. Constraints and triggers in the
 * database make over-refunding impossible even if two callers race: each ticket can be refunded once, and the
 * sum can never exceed what was paid. Money moves later (provider call, then ledger posting on success).
 */
export const createRefund = async (tx: PoolClient, input: NewRefund): Promise<string> => {
  const price = input.items.reduce((n, i) => n + i.price, 0);
  const fee = input.items.reduce((n, i) => n + i.fee, 0);
  const refundId = (await tx.query<{ id: string }>(
    `INSERT INTO refunds (order_id, kind, price_amount, fee_amount, amount, reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.orderId, input.kind, price, fee, price + fee, input.reason, input.requestedBy],
  )).rows[0]?.id ?? '';
  for (const i of input.items) {
    await tx.query(`INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount) VALUES ($1, $2, $3, $4)`, [refundId, i.itemId, i.price, i.fee]);
  }
  const ev = (await tx.query<{ event_id: string }>(`SELECT event_id FROM orders WHERE id = $1`, [input.orderId])).rows[0];
  if (input.releaseTickets && ev) {
    const ids = input.items.map((i) => i.itemId);
    await tx.query(`UPDATE tickets SET status = 'refunded' WHERE order_item_id = ANY($1::uuid[])`, [ids]);
    const freed = await tx.query<{ seat_id: string }>(
      `UPDATE event_seats es SET status = 'free' FROM tickets t WHERE t.order_item_id = ANY($1::uuid[]) AND t.seat_id = es.seat_id AND es.event_id = $2 AND es.status = 'sold' RETURNING es.seat_id`,
      [ids, ev.event_id],
    );
    const zones = await tx.query<{ zone_id: string; n: number }>(`SELECT zone_id, COUNT(*)::int AS n FROM order_items WHERE id = ANY($1::uuid[]) AND seat_id IS NULL GROUP BY zone_id ORDER BY zone_id`, [ids]);
    for (const z of zones.rows) {
      await tx.query(`UPDATE event_zones SET sold = GREATEST(0, sold - $3) WHERE event_id = $1 AND zone_id = $2`, [ev.event_id, z.zone_id, z.n]);
    }
    await tx.query(`UPDATE events SET sold_count = GREATEST(0, sold_count - $2) WHERE id = $1`, [ev.event_id, ids.length]);
    await tx.query(`UPDATE events SET status = 'on_sale' WHERE id = $1 AND status = 'sold_out' AND sold_count + blocked_count < capacity`, [ev.event_id]);
    await tx.query(`SELECT emit_seat_events($1, $2::bigint[], 'free', NULL)`, [ev.event_id, freed.rows.map((r) => Number(r.seat_id)).sort((a, b) => a - b)]);
    for (const z of zones.rows) await tx.query(`SELECT emit_zone_event($1, $2)`, [ev.event_id, z.zone_id]);
    await tx.query(`SELECT waitlist_offer_next($1)`, [ev.event_id]);
    const remaining = (await tx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM order_items i WHERE i.order_id = $1 AND NOT EXISTS (SELECT 1 FROM refund_items r WHERE r.order_item_id = i.id AND r.active)`,
      [input.orderId],
    )).rows[0]?.n ?? 0;
    await tx.query(`UPDATE orders SET status = $2::order_status WHERE id = $1 AND status IN ('paid', 'partially_refunded')`, [input.orderId, remaining === 0 ? 'refunded' : 'partially_refunded']);
  }
  await history(tx, input.orderId, input.requestedBy ? (input.kind === 'finance' ? 'finance' : 'buyer') : 'system', input.requestedBy, 'refund_requested', { refundId, kind: input.kind, amount: price + fee, reason: input.reason });
  await enqueue(tx, 'refund_execute', `refund:${refundId}`, { refundId });
  return refundId;
};

/** The provider confirmed the money went back: post it to the ledger once. */
export const applyRefundSucceeded = async (tx: PoolClient, refundId: string, providerRefundId: string | null): Promise<boolean> => {
  const refund = (await tx.query<{ status: string; order_id: string; kind: string; amount: number }>(`SELECT status, order_id, kind, amount FROM refunds WHERE id = $1 FOR UPDATE`, [refundId])).rows[0];
  if (!refund || refund.status === 'succeeded') return false;
  await tx.query(
    `UPDATE refunds SET status = 'succeeded', provider_refund_id = COALESCE(provider_refund_id, $2), completed_at = app_now(), updated_at = app_now() WHERE id = $1`,
    [refundId, providerRefundId],
  );
  await tx.query(`SELECT post_refund($1)`, [refundId]);
  if (refund.kind === 'late_payment') await tx.query(`UPDATE orders SET status = 'refunded' WHERE id = $1 AND status = 'expired'`, [refund.order_id]);
  await history(tx, refund.order_id, 'system', null, 'refund_succeeded', { refundId, amount: refund.amount });
  await enqueue(tx, 'email', `email:refund:${refundId}`, { template: 'refund', refundId });
  return true;
};

/**
 * The provider refused for good. The ticket was already handed back (its seat may be resold), so it stays returned; what is
 * left is a debt: the refund is marked failed, keeps its tickets (no second refund can be opened for them), shows on the
 * order, and is listed for finance, who retry it with `retryRefund`.
 */
export const applyRefundFailed = async (tx: PoolClient, refundId: string): Promise<void> => {
  const failed = await tx.query<{ order_id: string; amount: number }>(
    `UPDATE refunds SET status = 'failed', updated_at = app_now() WHERE id = $1 AND status IN ('requested', 'pending') RETURNING order_id, amount`,
    [refundId],
  );
  const row = failed.rows[0];
  if (row) await history(tx, row.order_id, 'system', null, 'refund_failed', { refundId, amount: row.amount });
};

/** Finance sends a failed refund to the provider again, as a new attempt (new idempotency key). Only a failed refund can be retried. */
export const retryRefund = async (tx: PoolClient, refundId: string, actorId: string): Promise<boolean> => {
  const res = await tx.query<{ order_id: string; provider_attempt: number }>(
    `UPDATE refunds SET status = 'requested', provider_attempt = provider_attempt + 1, updated_at = app_now()
     WHERE id = $1 AND status = 'failed' RETURNING order_id, provider_attempt`,
    [refundId],
  );
  const row = res.rows[0];
  if (!row) return false;
  await history(tx, row.order_id, 'finance', actorId, 'refund_retried', { refundId, attempt: row.provider_attempt });
  await enqueue(tx, 'refund_execute', `refund:${refundId}:retry:${row.provider_attempt}`, { refundId });
  return true;
};
