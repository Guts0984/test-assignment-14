/** Stage 1: configuration, users (all roles), halls, zones and seats. Plain SQL strings, run in one transaction. */

export const CONFIG_SQL = `
CREATE TEMP TABLE seed_cfg ON COMMIT DROP AS
SELECT $1::int AS users, $2::int AS orgs, $3::int AS scanners, $4::int AS finance, $5::int AS venues,
       $6::int AS events, $7::int AS tickets, $8::int AS arena_seats, $9::int AS arena_floor,
       $10::int AS venue_min, $11::int AS venue_max, $12::int AS soon_mod, $13::int AS arena_mod,
       $14::text AS pwd, now() AS anchor`;

export const USERS_SQL = `
INSERT INTO users (email, password_hash, display_name, role, created_at)
SELECT r.prefix || n || '@example.test', c.pwd, initcap(r.prefix) || ' ' || n, r.prefix::user_role,
       c.anchor - ((n * 7) % 365) * interval '1 day'
FROM seed_cfg c
CROSS JOIN LATERAL (
  SELECT 'organizer' AS prefix, c.orgs AS cnt UNION ALL
  SELECT 'scanner', c.scanners UNION ALL
  SELECT 'finance', c.finance UNION ALL
  SELECT 'buyer', c.users - c.orgs - c.scanners - c.finance
) r
CROSS JOIN LATERAL generate_series(1, r.cnt) n`;

export const BUYERS_SQL = `
CREATE TEMP TABLE seed_buyers ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY email) AS idx, id FROM users WHERE role = 'buyer';
CREATE UNIQUE INDEX ON seed_buyers (idx);
ANALYZE seed_buyers;
CREATE TEMP TABLE seed_orgs ON COMMIT DROP AS
SELECT regexp_replace(email, '\\D', '', 'g')::int AS n, id FROM users WHERE role = 'organizer';
CREATE UNIQUE INDEX ON seed_orgs (n)`;

export const VENUES_SQL = `
CREATE TEMP TABLE seed_venues ON COMMIT DROP AS
SELECT v, gen_random_uuid() AS id,
       CASE WHEN v = 1 THEN c.arena_seats
            ELSE (c.venue_min + ((v * 7919) % (c.venue_max - c.venue_min + 1)) / 10 * 10) END AS seated,
       CASE WHEN v = 1 THEN c.arena_floor WHEN v % 3 = 1 THEN 100 + (v * 37) % 200 ELSE 0 END AS floor_cap,
       (ARRAY['Kyiv','Lviv','Kharkiv','Odesa','Dnipro','Warsaw','Krakow','Gdansk','Poznan','Wroclaw'])[1 + v % 10] AS city,
       (SELECT id FROM seed_orgs WHERE n = 1 + (v - 1) % c.orgs) AS organizer_id
FROM seed_cfg c CROSS JOIN LATERAL generate_series(1, c.venues) v;
INSERT INTO venues (id, organizer_id, name, city, capacity)
SELECT id, organizer_id, CASE WHEN v = 1 THEN 'Arena' ELSE 'Hall ' || v END, city, seated + floor_cap FROM seed_venues`;

export const ZONES_SQL = `
CREATE TEMP TABLE seed_zones ON COMMIT DROP AS
SELECT gen_random_uuid() AS id, sv.id AS venue_id, sv.v, z.key, z.name, z.kind::zone_kind AS kind, z.cap, z.sort,
       CASE WHEN sv.v = 1 THEN 50 ELSE 20 END AS rowlen
FROM seed_venues sv
CROSS JOIN LATERAL (VALUES
  ('P', 'Parterre', 'seated', sv.seated * 50 / 100, 1),
  ('B', 'Balcony', 'seated', sv.seated * 30 / 100, 2),
  ('V', 'VIP', 'seated', sv.seated - sv.seated * 50 / 100 - sv.seated * 30 / 100, 3),
  ('F', 'Dance floor', 'general', sv.floor_cap, 4)
) z(key, name, kind, cap, sort)
WHERE z.cap > 0;
INSERT INTO zones (id, venue_id, key, name, kind, capacity, sort) SELECT id, venue_id, key, name, kind, cap, sort FROM seed_zones;
INSERT INTO seats (venue_id, zone_id, row_label, number, x, y)
SELECT z.venue_id, z.id, ((i / z.rowlen) + 1)::text, (i % z.rowlen) + 1, ((i % z.rowlen) * 12)::real, (z.sort * 1000 + (i / z.rowlen) * 14)::real
FROM seed_zones z CROSS JOIN LATERAL generate_series(0, z.cap - 1) i
WHERE z.kind = 'seated'
ORDER BY z.v, z.sort, i;
CREATE TEMP TABLE seed_seat_ord ON COMMIT DROP AS
SELECT s.id AS seat_id, s.venue_id, s.zone_id, row_number() OVER (PARTITION BY s.venue_id ORDER BY s.id) - 1 AS ord FROM seats s;
CREATE UNIQUE INDEX ON seed_seat_ord (venue_id, ord);
ANALYZE seed_seat_ord`;
