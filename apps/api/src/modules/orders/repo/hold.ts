import type { PoolClient } from 'pg';
import { enqueue } from '@ticketing/platform';
import { RULES } from '@ticketing/shared';
import { appError, err, ok, type Result } from '../../../common/result.js';
import { repriceOrder } from './reprice.js';

export interface HoldInput {
  readonly userId: string;
  readonly eventId: string;
  readonly seatIds: readonly number[];
  readonly general: readonly { readonly zoneId: string; readonly quantity: number }[];
}

export interface HoldOutcome {
  readonly orderId: string;
  /** True when this call created the order (the 10 minute timer started now). */
  readonly createdOrder: boolean;
}

const lock = (tx: PoolClient, key: string, shared: boolean): Promise<unknown> =>
  tx.query(`SELECT pg_advisory_xact_${shared ? 'lock_shared' : 'lock'}(hashtextextended($1, 0))`, [key]);

/** Releases orders whose hold expired by the server clock so their general-admission places become available again. */
const reclaimExpiredFor = async (tx: PoolClient, eventId: string, zoneId: string): Promise<void> => {
  await tx.query(
    `SELECT release_order(o.id) FROM orders o
     WHERE o.event_id = $1 AND o.status IN ('holding', 'awaiting_payment') AND o.hold_expires_at <= app_now()
       AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.zone_id = $2 AND i.seat_id IS NULL)
     ORDER BY o.hold_expires_at LIMIT 500`,
    [eventId, zoneId],
  );
};

/**
 * Holds seats and general-admission places for one user, all or nothing.
 *
 * Correctness rests on the database, not on timing:
 *  - a shared advisory lock on the event lets holds run in parallel while a cancellation (exclusive) waits for them;
 *  - an advisory lock per (user, event) serialises one buyer's parallel orders, so the per-person limit is exact;
 *  - seat rows are locked in id order (no deadlocks) and updated only if free or expired by `app_now()`;
 *  - the number of updated rows must equal the number requested, otherwise the savepoint is rolled back.
 */
export const holdInTx = async (tx: PoolClient, input: HoldInput): Promise<Result<HoldOutcome>> => {
  await lock(tx, `event:${input.eventId}`, true);
  await lock(tx, `uev:${input.userId}:${input.eventId}`, false);
  await tx.query('SAVEPOINT hold');
  const fail = async <T>(error: ReturnType<typeof appError>): Promise<Result<T>> => {
    await tx.query('ROLLBACK TO SAVEPOINT hold');
    return err(error);
  };

  const ev = (await tx.query<{ status: string; sales_start_at: Date; starts_at: Date; per_person_limit: number; now: Date }>(
    `SELECT status, sales_start_at, starts_at, per_person_limit, app_now() AS now FROM events WHERE id = $1`,
    [input.eventId],
  )).rows[0];
  if (!ev) return fail(appError('NOT_FOUND', 'Event not found'));
  if (!['on_sale', 'rescheduled'].includes(ev.status) || ev.starts_at <= ev.now) {
    return fail(appError('EVENT_NOT_ON_SALE', 'Tickets for this event are not on sale', { status: ev.status }));
  }
  if (ev.sales_start_at > ev.now) return fail(appError('EVENT_NOT_ON_SALE', 'Sales have not started yet', { salesStartAt: ev.sales_start_at.toISOString() }));

  let orderId: string | undefined;
  let createdOrder = false;
  const existing = (await tx.query<{ id: string; expired: boolean }>(
    `SELECT id, (hold_expires_at <= app_now()) AS expired FROM orders WHERE user_id = $1 AND event_id = $2 AND status = 'holding' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [input.userId, input.eventId],
  )).rows[0];
  if (existing?.expired) await tx.query(`SELECT release_order($1)`, [existing.id]);
  else orderId = existing?.id;

  const requested = input.seatIds.length + input.general.reduce((n, g) => n + g.quantity, 0);
  const inOrder = orderId ? ((await tx.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1`, [orderId])).rows[0]?.n ?? 0) : 0;
  if (inOrder + requested > RULES.maxSeatsPerOrder) {
    return fail(appError('LIMIT_EXCEEDED', `At most ${RULES.maxSeatsPerOrder} tickets per order`, { max: RULES.maxSeatsPerOrder, inOrder }));
  }
  const held = (await tx.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE o.user_id = $1 AND o.event_id = $2 AND (
       (o.status IN ('holding', 'awaiting_payment') AND o.hold_expires_at > app_now())
       OR (o.status IN ('paid', 'partially_refunded') AND NOT EXISTS (SELECT 1 FROM refund_items r WHERE r.order_item_id = i.id AND r.active)))`,
    [input.userId, input.eventId],
  )).rows[0]?.n ?? 0;
  if (held + requested > ev.per_person_limit) {
    return fail(appError('LIMIT_EXCEEDED', `Limit of ${ev.per_person_limit} tickets per person for this event`, { limit: ev.per_person_limit, current: held, requested }));
  }

  if (!orderId) {
    orderId = (await tx.query<{ id: string }>(
      `INSERT INTO orders (user_id, event_id, status, hold_expires_at) VALUES ($1, $2, 'holding', app_now() + make_interval(secs => $3::float8 / 1000.0)) RETURNING id`,
      [input.userId, input.eventId, RULES.holdTtlMs],
    )).rows[0]?.id;
    createdOrder = true;
    await enqueue(tx, 'hold_expire', `hold_expire:${orderId}`, { orderId }, RULES.holdTtlMs);
  }
  if (!orderId) throw new Error('order was not created');
  const expiry = (await tx.query<{ hold_expires_at: Date }>(`SELECT hold_expires_at FROM orders WHERE id = $1`, [orderId])).rows[0]?.hold_expires_at ?? new Date();

  const seatIds = [...input.seatIds].sort((a, b) => a - b);
  if (seatIds.length > 0) {
    await tx.query(`SELECT 1 FROM event_seats WHERE event_id = $1 AND seat_id = ANY($2::bigint[]) ORDER BY seat_id FOR UPDATE`, [input.eventId, seatIds]);
    const taken = await tx.query<{ seat_id: string; price: number; zone_id: string }>(
      `UPDATE event_seats es SET status = 'held', hold_order_id = $3, hold_expires_at = $4, reserved_for_offer_id = NULL
       FROM price_tiers pt
       WHERE es.event_id = $1 AND es.seat_id = ANY($2::bigint[]) AND pt.id = es.tier_id
         AND (es.status = 'free' OR (es.status = 'held' AND es.hold_expires_at <= app_now()))
         AND (es.reserved_for_offer_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM waitlist_offers w WHERE w.id = es.reserved_for_offer_id AND w.status = 'active' AND w.expires_at > app_now() AND w.user_id <> $5))
       RETURNING es.seat_id, pt.price, es.zone_id`,
      [input.eventId, seatIds, orderId, expiry, input.userId],
    );
    if (taken.rowCount !== seatIds.length) {
      const got = new Set(taken.rows.map((r) => Number(r.seat_id)));
      return fail(appError('SEAT_UNAVAILABLE', 'Some of the selected seats are no longer available', { unavailableSeatIds: seatIds.filter((s) => !got.has(s)) }));
    }
    await tx.query(
      `INSERT INTO order_items (order_id, event_id, zone_id, tier_id, seat_id, price)
       SELECT $1, $2, es.zone_id, es.tier_id, es.seat_id, pt.price FROM event_seats es JOIN price_tiers pt ON pt.id = es.tier_id WHERE es.event_id = $2 AND es.seat_id = ANY($3::bigint[])`,
      [orderId, input.eventId, seatIds],
    );
  }

  const zoneIds: string[] = [];
  for (const g of [...input.general].sort((a, b) => (a.zoneId < b.zoneId ? -1 : 1))) {
    const zoneRow = async () => (await tx.query<{ capacity: number; sold: number; held: number; kind: string; tier_id: string | null; price: number | null }>(
      `SELECT ez.capacity, ez.sold, ez.held + (SELECT COUNT(*) FROM waitlist_offers w WHERE w.event_id = ez.event_id AND w.zone_id = ez.zone_id AND w.status = 'active' AND w.expires_at > app_now() AND w.user_id <> $3)::int AS held, z.kind, ez.tier_id, pt.price FROM event_zones ez JOIN zones z ON z.id = ez.zone_id LEFT JOIN price_tiers pt ON pt.id = ez.tier_id
       WHERE ez.event_id = $1 AND ez.zone_id = $2 FOR UPDATE OF ez`,
      [input.eventId, g.zoneId, input.userId],
    )).rows[0];
    let zone = await zoneRow();
    if (!zone || zone.kind !== 'general' || zone.tier_id === null || zone.price === null) return fail(appError('NOT_FOUND', 'General admission zone not found', { zoneId: g.zoneId }));
    if (zone.capacity - zone.sold - zone.held < g.quantity) {
      await reclaimExpiredFor(tx, input.eventId, g.zoneId);
      zone = await zoneRow();
    }
    if (!zone || zone.capacity - zone.sold - zone.held < g.quantity) {
      return fail(appError('SEAT_UNAVAILABLE', 'Not enough places left in this zone', { zoneId: g.zoneId, available: Math.max(0, (zone?.capacity ?? 0) - (zone?.sold ?? 0) - (zone?.held ?? 0)) }));
    }
    await tx.query(`UPDATE event_zones SET held = held + $3 WHERE event_id = $1 AND zone_id = $2`, [input.eventId, g.zoneId, g.quantity]);
    await tx.query(
      `INSERT INTO order_items (order_id, event_id, zone_id, tier_id, price) SELECT $1, $2, $3, $4, $5 FROM generate_series(1, $6::int)`,
      [orderId, input.eventId, g.zoneId, zone.tier_id, zone.price, g.quantity],
    );
    zoneIds.push(g.zoneId);
  }

  await tx.query(
    `WITH used AS (UPDATE waitlist_offers SET status = 'used' WHERE event_id = $1 AND user_id = $2 AND status = 'active'
                   AND ((seat_id IS NOT NULL AND seat_id = ANY($3::bigint[])) OR (seat_id IS NULL AND zone_id = ANY($4::uuid[]))) RETURNING entry_id)
     UPDATE waitlist_entries SET status = 'fulfilled' WHERE id IN (SELECT entry_id FROM used)`,
    [input.eventId, input.userId, seatIds, zoneIds],
  );
  await repriceOrder(tx, orderId);
  await tx.query(
    `INSERT INTO order_history (order_id, actor_id, actor_role, type, data) VALUES ($1, $2, 'buyer', 'hold_added', $3::jsonb)`,
    [orderId, input.userId, JSON.stringify({ seatIds, general: input.general })],
  );
  // Last statements of the transaction: the event row is locked as briefly as possible.
  await tx.query(`SELECT emit_seat_events($1, $2::bigint[], 'held', $3::timestamptz)`, [input.eventId, seatIds, expiry]);
  for (const zoneId of zoneIds) await tx.query(`SELECT emit_zone_event($1, $2)`, [input.eventId, zoneId]);
  await tx.query('RELEASE SAVEPOINT hold');
  return ok({ orderId, createdOrder });
};
