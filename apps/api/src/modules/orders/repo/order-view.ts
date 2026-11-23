import type { Pool, PoolClient } from 'pg';
import type { OrderResponse } from '@ticketing/shared';

type Db = Pool | PoolClient;

export type OrderView = OrderResponse;

interface OrderRow {
  id: string;
  event_id: string;
  status: OrderView['status'];
  hold_expires_at: Date | null;
  now: Date;
  code: string | null;
  subtotal: number;
  discount: number;
  fee: number;
  total: number;
  created_at: Date;
  refund_state: OrderView['refundState'];
  items: { id: string; zone_id: string; seat_id: string | null; price: number; discount: number; fee: number }[];
}

const SELECT = `SELECT o.id, o.event_id,
  CASE WHEN o.status IN ('holding', 'awaiting_payment') AND o.hold_expires_at <= app_now() THEN 'expired' ELSE o.status::text END AS status, o.hold_expires_at, app_now() AS now, p.code, o.subtotal, o.discount, o.fee, o.total, o.created_at,
  (SELECT CASE WHEN bool_or(r.status = 'failed') THEN 'failed' WHEN bool_or(r.status IN ('requested', 'pending')) THEN 'in_progress'
               WHEN COUNT(*) > 0 THEN 'completed' ELSE 'none' END FROM refunds r WHERE r.order_id = o.id) AS refund_state,
  COALESCE((SELECT json_agg(json_build_object('id', i.id, 'zone_id', i.zone_id, 'seat_id', i.seat_id, 'price', i.price, 'discount', i.discount, 'fee', i.fee) ORDER BY i.seat_id NULLS LAST, i.id)
            FROM order_items i WHERE i.order_id = o.id), '[]') AS items
  FROM orders o LEFT JOIN promo_codes p ON p.id = o.promo_id`;

const toView = (r: OrderRow): OrderView => ({
  id: r.id,
  eventId: r.event_id,
  status: r.status,
  refundState: r.refund_state,
  holdExpiresAt: r.hold_expires_at?.toISOString() ?? null,
  serverTime: r.now.toISOString(),
  promoCode: r.code,
  subtotal: r.subtotal,
  discount: r.discount,
  fee: r.fee,
  total: r.total,
  createdAt: r.created_at.toISOString(),
  items: r.items.map((i) => ({ id: i.id, zoneId: i.zone_id, seatId: i.seat_id === null ? null : Number(i.seat_id), price: i.price, discount: i.discount, fee: i.fee })),
});

/** The order if it belongs to `userId`; otherwise null (a foreign order looks exactly like a missing one). */
export const loadOrder = async (db: Db, orderId: string, userId: string): Promise<OrderView | null> => {
  const res = await db.query<OrderRow>(`${SELECT} WHERE o.id = $1 AND o.user_id = $2`, [orderId, userId]);
  const row = res.rows[0];
  return row ? toView(row) : null;
};

export const listOrders = async (db: Db, userId: string): Promise<readonly OrderView[]> => {
  const res = await db.query<OrderRow>(`${SELECT} WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [userId]);
  return res.rows.map(toView);
};

export const loadHistory = async (db: Db, orderId: string, userId: string) => {
  const res = await db.query<{ at: Date; actor_role: string; actor_id: string | null; type: string; data: Record<string, unknown> }>(
    `SELECT h.at, h.actor_role, h.actor_id, h.type, h.data FROM order_history h JOIN orders o ON o.id = h.order_id WHERE h.order_id = $1 AND o.user_id = $2 ORDER BY h.id`,
    [orderId, userId],
  );
  return res.rows.map((r) => ({ at: r.at.toISOString(), actorRole: r.actor_role, actorId: r.actor_id, type: r.type, data: r.data }));
};
