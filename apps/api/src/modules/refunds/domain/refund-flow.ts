import type { Pool, PoolClient } from 'pg';
import { createRefund, lockEvent, lockOrder, retryRefund, withTxRetry } from '@ticketing/platform';
import { quoteRefund } from '@ticketing/shared';
import { appError, err, ok } from '../../../common/result.js';
import { requestHash, runIdempotent, type JsonValue } from '../../orders/domain/idempotency.js';

type Db = Pool | PoolClient;

export interface ItemState {
  readonly itemId: string;
  readonly paidPrice: number;
  readonly fee: number;
  readonly ticketStatus: 'valid' | 'refunded' | null;
  readonly entered: boolean;
  readonly ownedByBuyer: boolean;
  readonly alreadyRefunded: boolean;
}

interface EventTimes {
  readonly cancelled: boolean;
  readonly startsAtMs: number;
  readonly rescheduledAtMs: number | null;
  readonly nowMs: number;
}

export const loadItems = async (db: Db, orderId: string): Promise<readonly ItemState[]> => {
  const res = await db.query<{ id: string; price: number; discount: number; fee: number; tstatus: 'valid' | 'refunded' | null; entered: boolean; owned: boolean; refunded: boolean }>(
    `SELECT i.id, i.price, i.discount, i.fee, t.status AS tstatus, (t.entered_at IS NOT NULL) AS entered, (t.owner_id = o.user_id) AS owned,
            EXISTS (SELECT 1 FROM refund_items r WHERE r.order_item_id = i.id AND r.active) AS refunded
     FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN tickets t ON t.order_item_id = i.id WHERE i.order_id = $1 ORDER BY i.id`,
    [orderId],
  );
  return res.rows.map((r) => ({ itemId: r.id, paidPrice: r.price - r.discount, fee: r.fee, ticketStatus: r.tstatus, entered: r.entered, ownedByBuyer: r.owned, alreadyRefunded: r.refunded }));
};

const loadTimes = async (db: Db, eventId: string): Promise<EventTimes> => {
  const r = (await db.query<{ status: string; starts_at: Date; rescheduled_at: Date | null; now: Date }>(`SELECT status, starts_at, rescheduled_at, app_now() AS now FROM events WHERE id = $1`, [eventId])).rows[0];
  if (!r) throw new Error('event missing');
  return { cancelled: r.status === 'cancelled', startsAtMs: r.starts_at.getTime(), rescheduledAtMs: r.rescheduled_at?.getTime() ?? null, nowMs: r.now.getTime() };
};

export interface ItemQuote {
  readonly itemId: string;
  readonly refundable: boolean;
  readonly kind: string | null;
  readonly price: number;
  readonly fee: number;
  readonly reason: string | null;
}

/** Applies the refund policy from `packages/shared` to every ticket of the order. */
export const quoteItems = (items: readonly ItemState[], times: EventTimes): readonly ItemQuote[] =>
  items.map((i): ItemQuote => {
    if (i.alreadyRefunded || i.ticketStatus !== 'valid') return { itemId: i.itemId, refundable: false, kind: null, price: 0, fee: 0, reason: 'already_refunded' };
    if (i.entered) return { itemId: i.itemId, refundable: false, kind: null, price: 0, fee: 0, reason: 'already_used' };
    if (!i.ownedByBuyer) return { itemId: i.itemId, refundable: false, kind: null, price: 0, fee: 0, reason: 'transferred' };
    const q = quoteRefund({ paidPrice: i.paidPrice, paidFee: i.fee, nowMs: times.nowMs, startsAtMs: times.startsAtMs, eventCancelled: times.cancelled, rescheduledAtMs: times.rescheduledAtMs });
    return q.ok ? { itemId: i.itemId, refundable: true, kind: q.kind, price: q.price, fee: q.fee, reason: null } : { itemId: i.itemId, refundable: false, kind: null, price: 0, fee: 0, reason: q.reason };
  });

export const refundQuote = async (pool: Pool, orderId: string, userId: string) => {
  const order = (await pool.query<{ event_id: string }>(`SELECT event_id FROM orders WHERE id = $1 AND user_id = $2`, [orderId, userId])).rows[0];
  if (!order) return null;
  const quotes = quoteItems(await loadItems(pool, orderId), await loadTimes(pool, order.event_id));
  return { orderId, items: [...quotes], total: quotes.reduce((n, q) => n + q.price + q.fee, 0) };
};

export interface RefundView {
  readonly [key: string]: JsonValue;
}

const viewOf = async (db: Db, refundId: string): Promise<RefundView> => {
  const r = (await db.query<{ id: string; order_id: string; kind: string; status: string; amount: number; price_amount: number; fee_amount: number; reason: string | null; created_at: Date }>(`SELECT * FROM refunds WHERE id = $1`, [refundId])).rows[0];
  if (!r) throw new Error('refund missing');
  return { id: r.id, orderId: r.order_id, kind: r.kind, status: r.status, amount: r.amount, priceAmount: r.price_amount, feeAmount: r.fee_amount, reason: r.reason, createdAt: r.created_at.toISOString() };
};

/** The buyer returns tickets of their own order under the refund rules. Idempotent, and race-free through the order lock. */
export const userRefund = (pool: Pool, input: { readonly orderId: string; readonly userId: string; readonly itemIds: readonly string[] | undefined; readonly key: string }) =>
  runIdempotent<RefundView>(
    pool,
    { userId: input.userId, scope: `refund:${input.orderId}`, key: input.key, hash: requestHash({ orderId: input.orderId, itemIds: input.itemIds ? [...input.itemIds].sort() : null }) },
    async (tx) => {
      const order = await lockOrder(tx, input.orderId);
      if (!order || order.user_id !== input.userId) return err(appError('NOT_FOUND', 'Order not found'));
      await lockEvent(tx, order.event_id, true);
      if (order.status !== 'paid' && order.status !== 'partially_refunded') return err(appError('REFUND_NOT_ALLOWED', `Order is ${order.status}`, { reason: 'order_not_paid' }));
      const quotes = quoteItems(await loadItems(tx, order.id), await loadTimes(tx, order.event_id));
      const wanted = input.itemIds ? quotes.filter((q) => input.itemIds?.includes(q.itemId)) : quotes.filter((q) => q.refundable);
      if (input.itemIds && wanted.length !== new Set(input.itemIds).size) return err(appError('NOT_FOUND', 'Some tickets do not belong to this order'));
      const denied = wanted.find((q) => !q.refundable);
      if (denied || wanted.length === 0) return err(appError('REFUND_NOT_ALLOWED', 'These tickets cannot be refunded', { reason: denied?.reason ?? 'nothing_refundable', itemId: denied?.itemId ?? null }));
      const refundId = await createRefund(tx, {
        orderId: order.id, kind: 'user', reason: null, requestedBy: input.userId, releaseTickets: true,
        items: wanted.map((q) => ({ itemId: q.itemId, price: q.price, fee: q.fee })),
      });
      return ok(await viewOf(tx, refundId));
    },
  );

interface HeldTicket {
  readonly orderId: string;
  readonly itemId: string;
}

const heldTicket = async (db: Db, ticketId: string, userId: string, lock: boolean): Promise<HeldTicket | null> =>
  (await db.query<HeldTicket>(`SELECT order_id AS "orderId", order_item_id AS "itemId" FROM tickets WHERE id = $1 AND owner_id = $2${lock ? ' FOR UPDATE' : ''}`, [ticketId, userId])).rows[0] ?? null;

/** The ticket's refund under the policy, as seen by its holder (the buyer or the person it was transferred to). */
const quoteHeld = async (db: Db, held: HeldTicket, eventId: string): Promise<ItemQuote | null> => {
  const item = (await loadItems(db, held.orderId)).find((i) => i.itemId === held.itemId);
  return item ? (quoteItems([{ ...item, ownedByBuyer: true }], await loadTimes(db, eventId))[0] ?? null) : null;
};

export const ticketRefundQuote = async (pool: Pool, ticketId: string, userId: string) => {
  const held = await heldTicket(pool, ticketId, userId, false);
  if (!held) return null;
  const order = (await pool.query<{ event_id: string }>(`SELECT event_id FROM orders WHERE id = $1`, [held.orderId])).rows[0];
  const quote = order ? await quoteHeld(pool, held, order.event_id) : null;
  return quote ? { orderId: held.orderId, items: [quote], total: quote.price + quote.fee } : null;
};

/**
 * The current holder returns one ticket, whether they bought it or received it by transfer. The money goes back to the
 * payment it came from (the only place a refund can go). The original buyer cannot refund a ticket they gave away, so a
 * transferred ticket cannot be revoked behind the recipient's back.
 */
export const holderRefund = (pool: Pool, input: { readonly ticketId: string; readonly userId: string; readonly key: string }) =>
  runIdempotent<RefundView>(
    pool,
    { userId: input.userId, scope: `ticket-refund:${input.ticketId}`, key: input.key, hash: requestHash({ ticketId: input.ticketId }) },
    async (tx) => {
      const seen = await heldTicket(tx, input.ticketId, input.userId, false);
      if (!seen) return err(appError('NOT_FOUND', 'Ticket not found'));
      const order = await lockOrder(tx, seen.orderId); // same lock order as every other refund: order, event, then ticket
      if (!order) return err(appError('NOT_FOUND', 'Ticket not found'));
      await lockEvent(tx, order.event_id, true);
      const held = await heldTicket(tx, input.ticketId, input.userId, true);
      if (!held) return err(appError('NOT_FOUND', 'Ticket not found')); // transferred away meanwhile
      if (order.status !== 'paid' && order.status !== 'partially_refunded') return err(appError('REFUND_NOT_ALLOWED', `Order is ${order.status}`, { reason: 'order_not_paid' }));
      const quote = await quoteHeld(tx, held, order.event_id);
      if (!quote?.refundable) return err(appError('REFUND_NOT_ALLOWED', 'This ticket cannot be refunded', { reason: quote?.reason ?? 'nothing_refundable', itemId: held.itemId }));
      const refundId = await createRefund(tx, {
        orderId: order.id, kind: 'user', reason: null, requestedBy: input.userId, releaseTickets: true,
        items: [{ itemId: quote.itemId, price: quote.price, fee: quote.fee }],
      });
      return ok(await viewOf(tx, refundId));
    },
  );

/** Finance refunds the remaining tickets of an order in full (price and fee), whatever the policy says, with a reason. */
export const financeRefund = (pool: Pool, input: { readonly orderId: string; readonly actorId: string; readonly reason: string; readonly itemIds: readonly string[] | undefined; readonly key: string }) =>
  runIdempotent<RefundView>(
    pool,
    { userId: input.actorId, scope: `finance-refund:${input.orderId}`, key: input.key, hash: requestHash({ orderId: input.orderId, reason: input.reason, itemIds: input.itemIds ? [...input.itemIds].sort() : null }) },
    async (tx) => {
      const order = await lockOrder(tx, input.orderId);
      if (!order) return err(appError('NOT_FOUND', 'Order not found'));
      await lockEvent(tx, order.event_id, true);
      if (order.status !== 'paid' && order.status !== 'partially_refunded') return err(appError('REFUND_NOT_ALLOWED', `Order is ${order.status}`, { reason: 'order_not_paid' }));
      const items = (await loadItems(tx, order.id)).filter((i) => i.ticketStatus === 'valid' && !i.alreadyRefunded && (!input.itemIds || input.itemIds.includes(i.itemId)));
      if (items.length === 0) return err(appError('REFUND_NOT_ALLOWED', 'Nothing left to refund', { reason: 'nothing_refundable' }));
      const refundId = await createRefund(tx, {
        orderId: order.id, kind: 'finance', reason: input.reason, requestedBy: input.actorId, releaseTickets: true,
        items: items.map((i) => ({ itemId: i.itemId, price: i.paidPrice, fee: i.fee })),
      });
      return ok(await viewOf(tx, refundId));
    },
  );

export const listRefunds = async (pool: Pool, orderId: string, userId: string): Promise<readonly RefundView[] | null> => {
  const own = await pool.query(`SELECT 1 FROM orders WHERE id = $1 AND user_id = $2`, [orderId, userId]);
  if (own.rowCount === 0) return null;
  const ids = await pool.query<{ id: string }>(`SELECT id FROM refunds WHERE order_id = $1 ORDER BY created_at`, [orderId]);
  return withTxRetry(pool, async (tx) => Promise.all(ids.rows.map((r) => viewOf(tx, r.id))));
};

/** Refunds that need finance: rejected by the provider (money still owed to the buyer), newest first. */
export const failedRefunds = async (pool: Pool) => {
  const res = await pool.query<{ id: string; order_id: string; kind: string; status: string; amount: number; price_amount: number; fee_amount: number; reason: string | null; created_at: Date; updated_at: Date; provider_attempt: number; title: string }>(
    `SELECT r.*, e.title FROM refunds r JOIN orders o ON o.id = r.order_id JOIN events e ON e.id = o.event_id
     WHERE r.status = 'failed' ORDER BY r.updated_at DESC LIMIT 200`,
  );
  return res.rows.map((r) => ({
    id: r.id, orderId: r.order_id, kind: r.kind, status: r.status, amount: r.amount, priceAmount: r.price_amount, feeAmount: r.fee_amount,
    reason: r.reason, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), attempt: r.provider_attempt, eventTitle: r.title,
  }));
};

/** Finance retries a refund the provider rejected. Only a failed refund can be retried, so a double click is harmless. */
export const retryFailedRefund = async (pool: Pool, refundId: string, actorId: string) =>
  withTxRetry(pool, async (tx) => {
    const outcome = await retryRefund(tx, refundId, actorId);
    if (outcome === 'paid_out') return err(appError('CONFLICT', 'The event was already paid out; settle this refund outside the payout', { reason: 'paid_out' }));
    if (outcome === 'not_failed') {
      const exists = (await tx.query(`SELECT 1 FROM refunds WHERE id = $1`, [refundId])).rowCount === 1;
      return exists ? err(appError('CONFLICT', 'Only a failed refund can be retried')) : err(appError('NOT_FOUND', 'Refund not found'));
    }
    return ok(await viewOf(tx, refundId));
  });
