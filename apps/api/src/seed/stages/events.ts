/** Stage 2: events, price tiers, per-event zones and the ticket plan. */

export const EVENTS_SQL = `
CREATE TEMP TABLE seed_events ON COMMIT DROP AS
WITH base AS (
  SELECT e AS idx, c.anchor, c.soon_mod, c.arena_mod, c.venues,
         (e % c.soon_mod = 7) AS soon,
         (e % 97 = 1) AS draft,
         (e % 101 = 2) AS cancelled,
         (e % 53 = 3) AS resched
  FROM seed_cfg c CROSS JOIN LATERAL generate_series(1, c.events) e
), shaped AS (
  SELECT b.*,
         (b.soon OR b.draft OR b.cancelled OR b.resched) AS forced_future,
         CASE WHEN b.soon AND (b.idx / b.soon_mod) % 4 = 0 THEN 1
              WHEN b.idx % b.arena_mod = 0 THEN 1
              ELSE 2 + (b.idx * 13) % (b.venues - 1) END AS v
  FROM base b
), timed AS (
  SELECT s.*,
         s.anchor + (CASE WHEN s.forced_future THEN 20 + (s.idx * 37) % 100 WHEN s.idx % 29 = 9 THEN -1 ELSE (s.idx * 37) % 221 - 100 END) * interval '1 day'
                  + ((s.idx * 11) % 24) * interval '1 hour' AS starts_at
  FROM shaped s
)
SELECT t.idx, gen_random_uuid() AS id, sv.id AS venue_id, sv.organizer_id, sv.city, t.starts_at, t.soon, t.draft, t.cancelled, t.resched,
       sv.seated, sv.floor_cap, sv.seated + sv.floor_cap AS capacity,
       (NOT t.forced_future AND t.starts_at > t.anchor AND t.idx % 40 = 5) AS is_full,
       CASE
         WHEN t.draft THEN 'draft' WHEN t.cancelled THEN 'cancelled' WHEN t.resched THEN 'rescheduled'
         WHEN t.starts_at < t.anchor - interval '3 days' THEN 'paid_out'
         WHEN t.starts_at < t.anchor THEN 'finished'
         WHEN NOT t.forced_future AND t.idx % 40 = 5 THEN 'sold_out'
         ELSE 'on_sale' END::event_status AS status,
       CASE WHEN t.soon THEN t.anchor + interval '10 minutes'
            WHEN t.draft THEN t.starts_at - interval '30 days'
            ELSE LEAST(t.starts_at - interval '60 days', t.anchor - interval '1 day' - (t.idx % 30) * interval '1 day') END AS sales_start_at,
       (NOT t.soon AND NOT t.draft AND NOT t.cancelled) AS has_sales,
       (30000 + ((t.idx * 131) % 270) * 1000) AS base_price,
       (ARRAY['rock','pop','jazz','classical','electronic','theatre','comedy','festival'])[1 + t.idx % 8] AS category,
       0::int AS sold
FROM timed t JOIN seed_venues sv ON sv.v = t.v;
ALTER TABLE seed_events ADD COLUMN w numeric;
UPDATE seed_events SET sold = capacity WHERE is_full;
UPDATE seed_events SET w = capacity * (0.3 + 0.65 * ((idx * 7919) % 1000) / 1000.0) WHERE has_sales AND NOT is_full;
CREATE UNIQUE INDEX ON seed_events (id);
ANALYZE seed_events;
INSERT INTO events (id, organizer_id, venue_id, title, description, city, category, starts_at, previous_starts_at, rescheduled_at,
                    sales_start_at, status, per_person_limit, capacity, cancelled_at, created_at)
SELECT id, organizer_id, venue_id,
       initcap(category) || ' night #' || idx, 'Seeded event ' || idx, city, category, starts_at,
       CASE WHEN resched THEN starts_at - interval '7 days' END,
       CASE WHEN resched THEN (SELECT anchor - interval '5 days' FROM seed_cfg) END,
       sales_start_at, status, CASE WHEN idx % 17 = 0 THEN 4 ELSE 6 END, capacity,
       CASE WHEN cancelled THEN (SELECT anchor - interval '1 day' FROM seed_cfg) END,
       LEAST(sales_start_at, (SELECT anchor FROM seed_cfg)) - interval '2 days'
FROM seed_events`;

export const TIERS_SQL = `
CREATE TEMP TABLE seed_tiers ON COMMIT DROP AS
SELECT gen_random_uuid() AS id, e.id AS event_id, z.id AS zone_id, z.key, z.kind, z.cap, z.sort,
       ((e.base_price * (CASE z.key WHEN 'P' THEN 10 WHEN 'B' THEN 7 WHEN 'V' THEN 20 ELSE 8 END) / 10) / 100) * 100 AS price
FROM seed_events e JOIN seed_zones z ON z.venue_id = e.venue_id;
CREATE INDEX ON seed_tiers (event_id, zone_id);
ANALYZE seed_tiers;
INSERT INTO price_tiers (id, event_id, name, price, sort)
SELECT t.id, t.event_id, (SELECT name FROM seed_zones WHERE id = t.zone_id), t.price, t.sort FROM seed_tiers t;
INSERT INTO event_zones (event_id, zone_id, tier_id, capacity) SELECT event_id, zone_id, id, cap FROM seed_tiers;
UPDATE events ev SET min_price = m.mn, max_price = m.mx
FROM (SELECT event_id, MIN(price) AS mn, MAX(price) AS mx FROM seed_tiers GROUP BY event_id) m WHERE m.event_id = ev.id`;

/** Reads sold targets; the TypeScript runner scales them to the exact ticket total in between. */
export const TICKET_PLAN_SQL = `
CREATE TEMP TABLE seed_tickets ON COMMIT DROP AS
WITH plan AS (
  SELECT e.*, LEAST(e.floor_cap, ROUND(e.sold::numeric * e.floor_cap / NULLIF(e.capacity, 0))::int) AS sold_floor
  FROM seed_events e WHERE e.sold > 0
), gen AS (
  SELECT p.id AS event_id, p.idx, p.venue_id, p.organizer_id, p.starts_at, p.sales_start_at, p.sold, p.sold_floor, p.seated, p.is_full, g
  FROM plan p CROSS JOIN LATERAL generate_series(0, p.sold - 1) g
), placed AS (
  SELECT g.*, (g.g / 2) AS order_no,
         CASE WHEN g.g < g.sold_floor THEN NULL
              ELSE (((g.g - g.sold_floor)::bigint * 7727 + g.idx * 131) % g.seated)::int END AS ord
  FROM gen g
)
SELECT pl.event_id, pl.idx, pl.organizer_id, pl.starts_at, pl.sales_start_at, pl.g, pl.order_no,
       COALESCE(so.zone_id, (SELECT id FROM seed_zones z WHERE z.venue_id = pl.venue_id AND z.key = 'F')) AS zone_id,
       so.seat_id,
       pl.sold, pl.is_full
FROM placed pl
LEFT JOIN seed_seat_ord so ON so.venue_id = pl.venue_id AND so.ord = pl.ord;
ANALYZE seed_tickets`;

export const TICKET_PRICING_SQL = `
CREATE TEMP TABLE seed_items ON COMMIT DROP AS
SELECT t.event_id, t.g, t.order_no, t.organizer_id, t.zone_id, t.seat_id, t.starts_at, t.sales_start_at,
       md5('o' || t.event_id || ':' || t.order_no)::uuid AS order_id,
       md5('i' || t.event_id || ':' || t.g)::uuid AS item_id,
       tr.id AS tier_id, tr.price, GREATEST(2000, (tr.price * 5 + 50) / 100) AS fee,
       (NOT t.is_full AND t.g % 2 = 0 AND t.g + 1 < t.sold
         AND abs(hashtextextended(t.event_id || ':' || t.order_no, 7)) % 50 = 0) AS refunded,
       LEAST(c.anchor, t.starts_at - interval '1 hour') AS sales_end,
       (abs(hashtextextended(t.event_id || ':' || t.order_no, 3)) / 9.2233720368547758e18)::float8 AS u
FROM seed_tickets t
JOIN seed_tiers tr ON tr.event_id = t.event_id AND tr.zone_id = t.zone_id
CROSS JOIN seed_cfg c;
ALTER TABLE seed_items ADD COLUMN paid_at timestamptz;
UPDATE seed_items SET paid_at = sales_start_at + (sales_end - sales_start_at) * power(u, 2);
CREATE INDEX ON seed_items (order_id);
CREATE INDEX ON seed_items (event_id, seat_id);
ANALYZE seed_items`;
