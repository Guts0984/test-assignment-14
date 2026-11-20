import type { Pool } from 'pg';
import { buildSearch, type SearchParams } from '../domain/search-query.js';

interface EventRow {
  id: string;
  title: string;
  description: string;
  city: string;
  category: string;
  starts_at: Date;
  sales_start_at: Date;
  status: 'draft' | 'on_sale' | 'sold_out' | 'rescheduled' | 'cancelled' | 'finished' | 'paid_out';
  min_price: number | null;
  max_price: number | null;
  capacity: number;
  sold_count: number;
  blocked_count: number;
  venue_name: string;
  venue_id: string;
  organizer_id: string;
  per_person_limit: number;
  rescheduled_at: Date | null;
  queue_active: boolean;
}

const SELECT_EVENT = `SELECT e.id, e.title, e.description, e.city, e.category, e.starts_at, e.sales_start_at, e.status, e.min_price, e.max_price,
  e.capacity, e.sold_count, e.blocked_count, v.name AS venue_name, e.venue_id, e.organizer_id, e.per_person_limit, e.rescheduled_at, e.queue_active
  FROM events e JOIN venues v ON v.id = e.venue_id`;

export const toSummary = (r: EventRow) => ({
  id: r.id,
  title: r.title,
  city: r.city,
  category: r.category,
  startsAt: r.starts_at.toISOString(),
  salesStartAt: r.sales_start_at.toISOString(),
  status: r.status,
  minPrice: r.min_price,
  maxPrice: r.max_price,
  capacity: r.capacity,
  soldCount: r.sold_count,
  hasSeats: r.sold_count + r.blocked_count < r.capacity,
  venueName: r.venue_name,
});

export const searchEvents = async (pool: Pool, params: SearchParams) => {
  const q = buildSearch(params);
  const [rows, total] = await Promise.all([
    pool.query<EventRow>(`${SELECT_EVENT} WHERE ${q.where} ORDER BY ${q.orderBy} LIMIT ${q.limit} OFFSET ${q.offset}`, [...q.params]),
    pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM events e WHERE ${q.where}`, [...q.params]),
  ]);
  return { items: rows.rows.map(toSummary), total: total.rows[0]?.n ?? 0, page: params.page, pageSize: params.pageSize };
};

/** Drafts are visible to their organizer only; everything else is public. */
export const getEventDetail = async (pool: Pool, eventId: string, viewerId: string | null) => {
  const res = await pool.query<EventRow>(`${SELECT_EVENT} WHERE e.id = $1 AND (e.status <> 'draft' OR e.organizer_id = $2)`, [eventId, viewerId]);
  const row = res.rows[0];
  if (!row) return null;
  const zones = await pool.query<{ id: string; name: string; kind: 'seated' | 'general'; capacity: number; available: number; price: number | null }>(
    `SELECT z.id, z.name, z.kind, ez.capacity, pt.price,
            CASE WHEN z.kind = 'general'
              THEN ez.capacity - ez.sold - (SELECT COUNT(*) FROM order_items i JOIN orders o ON o.id = i.order_id
                   WHERE i.event_id = ez.event_id AND i.zone_id = ez.zone_id AND i.seat_id IS NULL AND o.status IN ('holding', 'awaiting_payment') AND o.hold_expires_at > app_now())
              ELSE (SELECT COUNT(*) FROM event_seats s WHERE s.event_id = ez.event_id AND s.zone_id = ez.zone_id AND (s.status = 'free' OR (s.status = 'held' AND s.hold_expires_at <= app_now())))
            END::int AS available
     FROM event_zones ez JOIN zones z ON z.id = ez.zone_id LEFT JOIN price_tiers pt ON pt.id = ez.tier_id
     WHERE ez.event_id = $1 ORDER BY z.sort`,
    [eventId],
  );
  return {
    ...toSummary(row),
    description: row.description,
    venueId: row.venue_id,
    organizerId: row.organizer_id,
    perPersonLimit: row.per_person_limit,
    rescheduledAt: row.rescheduled_at?.toISOString() ?? null,
    queueActive: row.queue_active,
    zones: zones.rows,
  };
};

export const listOrganizerEvents = async (pool: Pool, organizerId: string) => {
  const res = await pool.query<EventRow>(`${SELECT_EVENT} WHERE e.organizer_id = $1 ORDER BY e.starts_at DESC LIMIT 200`, [organizerId]);
  return { items: res.rows.map(toSummary), total: res.rows.length, page: 1, pageSize: 200 };
};
