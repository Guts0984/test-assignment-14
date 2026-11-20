import type { Pool } from 'pg';

const STATUS_CODE = { free: 0, held: 1, sold: 2, blocked: 3 } as const;

/** Static geometry and prices of an event hall (cacheable): seats in id order, columnar. */
export const getSeatLayout = async (pool: Pool, eventId: string) => {
  const [zones, tiers, seats] = await Promise.all([
    pool.query<{ id: string; name: string; kind: 'seated' | 'general'; capacity: number; tier_id: string | null }>(
      `SELECT z.id, z.name, z.kind, ez.capacity, ez.tier_id FROM event_zones ez JOIN zones z ON z.id = ez.zone_id WHERE ez.event_id = $1 ORDER BY z.sort`,
      [eventId],
    ),
    pool.query<{ id: string; name: string; price: number }>(`SELECT id, name, price FROM price_tiers WHERE event_id = $1 ORDER BY sort, id`, [eventId]),
    pool.query<{ seat_id: string; zone_id: string; tier_id: string | null; row_label: string; number: number; x: number; y: number }>(
      `SELECT es.seat_id, es.zone_id, es.tier_id, s.row_label, s.number, s.x, s.y FROM event_seats es JOIN seats s ON s.id = es.seat_id WHERE es.event_id = $1 ORDER BY es.seat_id`,
      [eventId],
    ),
  ]);
  if (zones.rowCount === 0) return null;
  const tierIndex = new Map(tiers.rows.map((t, i) => [t.id, i]));
  const zoneIndex = new Map(zones.rows.map((z, i) => [z.id, i]));
  return {
    eventId,
    zones: zones.rows.map((z) => ({ id: z.id, name: z.name, kind: z.kind, capacity: z.capacity, tierIndex: z.tier_id ? (tierIndex.get(z.tier_id) ?? null) : null })),
    tiers: tiers.rows.map((t) => ({ name: t.name, price: t.price })),
    seats: {
      id: seats.rows.map((r) => Number(r.seat_id)),
      zone: seats.rows.map((r) => zoneIndex.get(r.zone_id) ?? -1),
      tier: seats.rows.map((r) => (r.tier_id ? (tierIndex.get(r.tier_id) ?? -1) : -1)),
      row: seats.rows.map((r) => r.row_label),
      number: seats.rows.map((r) => r.number),
      x: seats.rows.map((r) => r.x),
      y: seats.rows.map((r) => r.y),
    },
  };
};

/**
 * Live state in layout order, judged by the database clock: a hold past its expiry counts as free even if no worker
 * has released it yet. `seq` is read first, so replaying events after `seq` always converges to the newest state.
 */
export const getSeatState = async (pool: Pool, eventId: string) => {
  const seqRow = await pool.query<{ seat_seq: string; now: Date }>(`SELECT seat_seq, app_now() AS now FROM events WHERE id = $1`, [eventId]);
  const head = seqRow.rows[0];
  if (!head) return null;
  const [seats, general] = await Promise.all([
    pool.query<{ seat_id: string; status: keyof typeof STATUS_CODE; hold_expires_at: Date | null; offer_until: Date | null }>(
      `SELECT es.seat_id, es.status, es.hold_expires_at, wo.expires_at AS offer_until FROM event_seats es
       LEFT JOIN waitlist_offers wo ON wo.id = es.reserved_for_offer_id AND wo.status = 'active' AND wo.expires_at > app_now()
       WHERE es.event_id = $1 ORDER BY es.seat_id`,
      [eventId],
    ),
    pool.query<{ zone_id: string; available: number }>(
      `SELECT ez.zone_id, (ez.capacity - ez.sold - (SELECT COUNT(*) FROM order_items i JOIN orders o ON o.id = i.order_id
          WHERE i.event_id = ez.event_id AND i.zone_id = ez.zone_id AND i.seat_id IS NULL AND o.status IN ('holding', 'awaiting_payment') AND o.hold_expires_at > app_now()))::int AS available
       FROM event_zones ez JOIN zones z ON z.id = ez.zone_id WHERE ez.event_id = $1 AND z.kind = 'general'`,
      [eventId],
    ),
  ]);
  const now = head.now.getTime();
  const heldUntil: [number, number][] = [];
  const status = seats.rows.map((r) => {
    if (r.status === 'held') {
      const until = r.hold_expires_at?.getTime() ?? 0;
      if (until > now) {
        heldUntil.push([Number(r.seat_id), until]);
        return STATUS_CODE.held;
      }
    }
    if ((r.status === 'free' || r.status === 'held') && r.offer_until) {
      heldUntil.push([Number(r.seat_id), r.offer_until.getTime()]); // reserved for the person at the head of the waitlist
      return STATUS_CODE.held;
    }
    return r.status === 'held' ? STATUS_CODE.free : STATUS_CODE[r.status];
  });
  return {
    eventId,
    seq: Number(head.seat_seq),
    serverTime: head.now.toISOString(),
    status,
    heldUntil,
    general: general.rows.map((g) => ({ zoneId: g.zone_id, available: g.available })),
  };
};
