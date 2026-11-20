/** Stage 3: orders, order items, payments, tickets, seat states, refunds and event counters. */

export const ORDERS_SQL = `
CREATE TEMP TABLE seed_orders ON COMMIT DROP AS
WITH grouped AS (
  SELECT i.order_id, i.event_id, i.organizer_id, MIN(i.paid_at) AS paid_at, SUM(i.price) AS subtotal, SUM(i.fee) AS fee,
         SUM(i.price) + SUM(i.fee) AS total, COUNT(*) AS items, COUNT(*) FILTER (WHERE i.refunded) AS refunded_items
  FROM seed_items i GROUP BY i.order_id, i.event_id, i.organizer_id
), buyer_count AS (SELECT COUNT(*) AS n FROM seed_buyers)
SELECT g.*, b.id AS user_id
FROM grouped g CROSS JOIN buyer_count bc
JOIN seed_buyers b ON b.idx = 1 + abs(hashtextextended(g.order_id::text, 1)) % bc.n;
CREATE UNIQUE INDEX ON seed_orders (order_id);
ANALYZE seed_orders;
INSERT INTO orders (id, user_id, event_id, status, hold_expires_at, subtotal, discount, fee, total, paid_at, created_at, updated_at)
SELECT order_id, user_id, event_id,
       CASE WHEN refunded_items = 0 THEN 'paid' WHEN refunded_items = items THEN 'refunded' ELSE 'partially_refunded' END::order_status,
       paid_at - interval '3 minutes' + interval '10 minutes', subtotal, 0, fee, total, paid_at, paid_at - interval '3 minutes', paid_at
FROM seed_orders;
INSERT INTO order_items (id, order_id, event_id, zone_id, tier_id, seat_id, price, discount, fee)
SELECT item_id, order_id, event_id, zone_id, tier_id, seat_id, price, 0, fee FROM seed_items;
INSERT INTO payments (id, order_id, amount, status, provider_payment_id, created_at, updated_at, succeeded_at)
SELECT md5('p' || order_id)::uuid, order_id, total, 'succeeded', 'seed_' || replace(order_id::text, '-', ''),
       paid_at - interval '2 minutes', paid_at, paid_at
FROM seed_orders;
INSERT INTO tickets (id, order_id, order_item_id, event_id, owner_id, seat_id, zone_id, status, created_at)
SELECT md5('t' || i.item_id)::uuid, i.order_id, i.item_id, i.event_id, o.user_id, i.seat_id, i.zone_id,
       CASE WHEN i.refunded THEN 'refunded' ELSE 'valid' END::ticket_status, i.paid_at
FROM seed_items i JOIN seed_orders o ON o.order_id = i.order_id`;

export const SEATS_SQL = `
DROP INDEX event_seats_status_idx;
DROP INDEX event_seats_expiry_idx;
DROP INDEX event_seats_order_idx;
INSERT INTO event_seats (event_id, seat_id, zone_id, tier_id, status)
SELECT e.id, s.id, s.zone_id, tr.id,
       CASE WHEN i.seat_id IS NOT NULL AND NOT i.refunded THEN 'sold' ELSE 'free' END::seat_status
FROM seed_events e
JOIN seats s ON s.venue_id = e.venue_id
JOIN seed_tiers tr ON tr.event_id = e.id AND tr.zone_id = s.zone_id
LEFT JOIN seed_items i ON i.event_id = e.id AND i.seat_id = s.id;
UPDATE event_zones ez SET sold = x.n
FROM (SELECT event_id, zone_id, COUNT(*) AS n FROM seed_items WHERE seat_id IS NULL AND NOT refunded GROUP BY 1, 2) x
WHERE x.event_id = ez.event_id AND x.zone_id = ez.zone_id;
CREATE INDEX event_seats_status_idx ON event_seats (event_id, status);
CREATE INDEX event_seats_expiry_idx ON event_seats (hold_expires_at) WHERE status = 'held';
CREATE INDEX event_seats_order_idx ON event_seats (hold_order_id) WHERE hold_order_id IS NOT NULL;
UPDATE events ev SET sold_count = x.n
FROM (SELECT event_id, COUNT(*) FILTER (WHERE NOT refunded) AS n FROM seed_items GROUP BY 1) x WHERE x.event_id = ev.id;
INSERT INTO event_staff (event_id, user_id)
SELECT e.id, u.id FROM seed_events e
JOIN users u ON u.email = 'scanner' || (1 + e.idx % (SELECT scanners FROM seed_cfg)) || '@example.test'
WHERE e.has_sales OR e.soon`;

export const REFUNDS_SQL = `
INSERT INTO refunds (id, order_id, kind, status, price_amount, fee_amount, amount, reason, created_at, updated_at, completed_at)
SELECT md5('r' || i.item_id)::uuid, i.order_id, 'user', 'succeeded', i.price, 0, i.price, 'seed',
       LEAST(i.paid_at + interval '1 day', (SELECT anchor FROM seed_cfg)), LEAST(i.paid_at + interval '1 day', (SELECT anchor FROM seed_cfg)),
       LEAST(i.paid_at + interval '1 day', (SELECT anchor FROM seed_cfg))
FROM seed_items i WHERE i.refunded;
INSERT INTO refund_items (refund_id, order_item_id, price_amount, fee_amount)
SELECT md5('r' || i.item_id)::uuid, i.item_id, i.price, 0 FROM seed_items i WHERE i.refunded`;
