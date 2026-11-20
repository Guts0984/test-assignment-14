-- Source of truth schema. Money columns are integer kopecks. All time-dependent defaults use app_now().
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Mockable clock. Production never writes test_clock (the test endpoint is not registered).
-- ---------------------------------------------------------------------------
CREATE TABLE test_clock (
  id        integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  offset_ms bigint  NOT NULL DEFAULT 0
);
INSERT INTO test_clock DEFAULT VALUES;

CREATE FUNCTION app_now() RETURNS timestamptz
LANGUAGE sql VOLATILE AS $$
  SELECT clock_timestamp() + make_interval(secs => offset_ms / 1000.0) FROM test_clock
$$;

CREATE TYPE user_role    AS ENUM ('buyer', 'organizer', 'scanner', 'finance');
CREATE TYPE order_status AS ENUM ('holding', 'awaiting_payment', 'paid', 'expired', 'partially_refunded', 'refunded');
CREATE TYPE event_status AS ENUM ('draft', 'on_sale', 'sold_out', 'rescheduled', 'cancelled', 'finished', 'paid_out');
CREATE TYPE seat_status  AS ENUM ('free', 'held', 'sold', 'blocked');
CREATE TYPE zone_kind    AS ENUM ('seated', 'general');
CREATE TYPE promo_kind   AS ENUM ('percent', 'fixed');
CREATE TYPE payment_status AS ENUM ('created', 'pending', 'succeeded', 'failed');
CREATE TYPE refund_kind   AS ENUM ('user', 'finance', 'event_cancelled', 'late_payment');
CREATE TYPE refund_status AS ENUM ('requested', 'pending', 'succeeded', 'failed');
CREATE TYPE ticket_status AS ENUM ('valid', 'refunded');
CREATE TYPE task_status   AS ENUM ('pending', 'running', 'done', 'failed');
CREATE TYPE queue_status  AS ENUM ('waiting', 'admitted', 'selecting', 'done', 'expired', 'left');
CREATE TYPE waitlist_status AS ENUM ('waiting', 'offered', 'fulfilled', 'left');
CREATE TYPE offer_status  AS ENUM ('active', 'expired', 'used', 'cancelled');
CREATE TYPE email_status  AS ENUM ('pending', 'sent', 'failed');
CREATE TYPE payout_status AS ENUM ('pending', 'paid');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  password_hash text NOT NULL,
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  role          user_role NOT NULL DEFAULT 'buyer',
  created_at    timestamptz NOT NULL DEFAULT app_now()
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT app_now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Venues
-- ---------------------------------------------------------------------------
CREATE TABLE venues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid REFERENCES users(id),
  name         text NOT NULL,
  city         text NOT NULL,
  capacity     integer NOT NULL CHECK (capacity > 0),
  created_at   timestamptz NOT NULL DEFAULT app_now()
);
CREATE INDEX venues_organizer_idx ON venues (organizer_id);

CREATE TABLE zones (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id  uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  key       text NOT NULL,
  name      text NOT NULL,
  kind      zone_kind NOT NULL,
  capacity  integer NOT NULL CHECK (capacity > 0),
  geometry  jsonb,
  sort      integer NOT NULL DEFAULT 0,
  UNIQUE (venue_id, key)
);

CREATE TABLE seats (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue_id  uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  zone_id   uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  row_label text NOT NULL,
  number    integer NOT NULL,
  x         real NOT NULL,
  y         real NOT NULL,
  UNIQUE (zone_id, row_label, number)
);
CREATE INDEX seats_venue_idx ON seats (venue_id);

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id       uuid NOT NULL REFERENCES users(id),
  venue_id           uuid NOT NULL REFERENCES venues(id),
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description        text NOT NULL DEFAULT '',
  city               text NOT NULL,
  category           text NOT NULL,
  starts_at          timestamptz NOT NULL,
  previous_starts_at timestamptz,
  rescheduled_at     timestamptz,
  sales_start_at     timestamptz NOT NULL,
  status             event_status NOT NULL DEFAULT 'draft',
  per_person_limit   integer NOT NULL DEFAULT 6 CHECK (per_person_limit BETWEEN 1 AND 50),
  capacity           integer NOT NULL CHECK (capacity > 0),
  sold_count         integer NOT NULL DEFAULT 0,
  blocked_count      integer NOT NULL DEFAULT 0,
  min_price          integer,
  max_price          integer,
  seat_seq           bigint NOT NULL DEFAULT 0,
  queue_active       boolean NOT NULL DEFAULT false,
  cancelled_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT app_now(),
  CHECK (sold_count >= 0 AND blocked_count >= 0 AND sold_count + blocked_count <= capacity),
  CHECK (sales_start_at <= starts_at),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX events_title_trgm_idx ON events USING gin (title gin_trgm_ops);
CREATE INDEX events_city_idx ON events (city, starts_at);
CREATE INDEX events_category_idx ON events (category, starts_at);
CREATE INDEX events_status_start_idx ON events (status, starts_at);
CREATE INDEX events_organizer_idx ON events (organizer_id, starts_at);
CREATE INDEX events_venue_idx ON events (venue_id);

CREATE TABLE event_staff (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_staff_user_idx ON event_staff (user_id);

CREATE TABLE price_tiers (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name     text NOT NULL,
  price    integer NOT NULL CHECK (price BETWEEN 100 AND 10000000),
  sort     integer NOT NULL DEFAULT 0
);
CREATE INDEX price_tiers_event_idx ON price_tiers (event_id);

-- Per event and zone. For general-admission zones sold/held are the capacity counters.
CREATE TABLE event_zones (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  zone_id  uuid NOT NULL REFERENCES zones(id),
  tier_id  uuid REFERENCES price_tiers(id),
  capacity integer NOT NULL CHECK (capacity > 0),
  sold     integer NOT NULL DEFAULT 0,
  held     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, zone_id),
  CHECK (sold >= 0 AND held >= 0 AND sold + held <= capacity)
);

CREATE TABLE event_seats (
  event_id                uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seat_id                 bigint NOT NULL REFERENCES seats(id),
  zone_id                 uuid NOT NULL REFERENCES zones(id),
  tier_id                 uuid REFERENCES price_tiers(id),
  status                  seat_status NOT NULL DEFAULT 'free',
  hold_order_id           uuid,
  hold_expires_at         timestamptz,
  reserved_for_offer_id   uuid,
  PRIMARY KEY (event_id, seat_id),
  CHECK ((status = 'held') = (hold_order_id IS NOT NULL)),
  CHECK ((status = 'held') = (hold_expires_at IS NOT NULL))
);
CREATE INDEX event_seats_status_idx ON event_seats (event_id, status);
CREATE INDEX event_seats_expiry_idx ON event_seats (hold_expires_at) WHERE status = 'held';
CREATE INDEX event_seats_order_idx ON event_seats (hold_order_id) WHERE hold_order_id IS NOT NULL;

-- Ordered change feed used for live updates and reconnect catch-up.
CREATE TABLE seat_events (
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seq        bigint NOT NULL,
  seat_id    bigint,
  zone_id    uuid,
  status     text NOT NULL,
  held_until timestamptz,
  available  integer,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  PRIMARY KEY (event_id, seq)
);

CREATE TABLE promo_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES users(id),
  event_id     uuid REFERENCES events(id) ON DELETE CASCADE,
  code         text NOT NULL UNIQUE CHECK (code = upper(code) AND length(code) BETWEEN 3 AND 40),
  kind         promo_kind NOT NULL,
  value        integer NOT NULL CHECK (value > 0),
  usage_limit  integer NOT NULL CHECK (usage_limit > 0),
  used_count   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT app_now(),
  CHECK (used_count >= 0 AND used_count <= usage_limit),
  CHECK (kind <> 'percent' OR value <= 100)
);
CREATE INDEX promo_codes_organizer_idx ON promo_codes (organizer_id);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  event_id        uuid NOT NULL REFERENCES events(id),
  status          order_status NOT NULL DEFAULT 'holding',
  hold_expires_at timestamptz,
  promo_id        uuid REFERENCES promo_codes(id),
  promo_held      boolean NOT NULL DEFAULT false,
  subtotal        integer NOT NULL DEFAULT 0,
  discount        integer NOT NULL DEFAULT 0,
  fee             integer NOT NULL DEFAULT 0,
  total           integer NOT NULL DEFAULT 0,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT app_now(),
  updated_at      timestamptz NOT NULL DEFAULT app_now(),
  CHECK (subtotal >= 0 AND discount >= 0 AND discount <= subtotal AND fee >= 0),
  CHECK (total = subtotal - discount + fee),
  CHECK (status NOT IN ('paid', 'partially_refunded', 'refunded') OR paid_at IS NOT NULL)
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_event_status_idx ON orders (event_id, status);
CREATE INDEX orders_hold_expiry_idx ON orders (hold_expires_at) WHERE status IN ('holding', 'awaiting_payment');
CREATE INDEX orders_promo_idx ON orders (promo_id) WHERE promo_id IS NOT NULL;
CREATE INDEX orders_paid_at_idx ON orders (paid_at) WHERE paid_at IS NOT NULL;

CREATE TABLE order_items (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id),
  zone_id  uuid NOT NULL REFERENCES zones(id),
  tier_id  uuid REFERENCES price_tiers(id),
  seat_id  bigint REFERENCES seats(id),
  price    integer NOT NULL CHECK (price > 0),
  discount integer NOT NULL DEFAULT 0 CHECK (discount >= 0),
  fee      integer NOT NULL DEFAULT 0 CHECK (fee >= 0),
  CHECK (discount <= price)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_event_idx ON order_items (event_id);

-- Append-only audit trail of an order: who and when.
CREATE TABLE order_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT app_now(),
  actor_id   uuid,
  actor_role text NOT NULL,
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX order_history_order_idx ON order_history (order_id, id);

CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  scope           text NOT NULL,
  key             text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT app_now(),
  UNIQUE (user_id, scope, key)
);

-- ---------------------------------------------------------------------------
-- Payments and refunds
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders(id),
  amount              integer NOT NULL CHECK (amount > 0),
  status              payment_status NOT NULL DEFAULT 'created',
  provider_payment_id text UNIQUE,
  last_event_seq      integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT app_now(),
  updated_at          timestamptz NOT NULL DEFAULT app_now(),
  succeeded_at        timestamptz
);
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE INDEX payments_pending_idx ON payments (status, created_at) WHERE status IN ('created', 'pending');
-- one successful payment per order
CREATE UNIQUE INDEX payments_one_success_idx ON payments (order_id) WHERE status = 'succeeded';

CREATE TABLE payment_events (
  provider_event_id text PRIMARY KEY,
  payment_id        uuid,
  kind              text NOT NULL,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT app_now()
);

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id),
  kind               refund_kind NOT NULL,
  status             refund_status NOT NULL DEFAULT 'requested',
  price_amount       integer NOT NULL CHECK (price_amount >= 0),
  fee_amount         integer NOT NULL CHECK (fee_amount >= 0),
  amount             integer NOT NULL CHECK (amount > 0),
  reason             text,
  requested_by       uuid,
  provider_refund_id text UNIQUE,
  last_event_seq     integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT app_now(),
  updated_at         timestamptz NOT NULL DEFAULT app_now(),
  completed_at       timestamptz,
  CHECK (amount = price_amount + fee_amount)
);
CREATE INDEX refunds_order_idx ON refunds (order_id);
CREATE INDEX refunds_status_idx ON refunds (status, created_at) WHERE status IN ('requested', 'pending');

CREATE TABLE refund_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id     uuid NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  price_amount  integer NOT NULL CHECK (price_amount >= 0),
  fee_amount    integer NOT NULL CHECK (fee_amount >= 0),
  active        boolean NOT NULL DEFAULT true
);
-- A ticket can be refunded at most once (unless the provider rejected the earlier attempt).
CREATE UNIQUE INDEX refund_items_once_idx ON refund_items (order_item_id) WHERE active;
CREATE INDEX refund_items_refund_idx ON refund_items (refund_id);

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------
CREATE TABLE tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id),
  order_item_id uuid NOT NULL UNIQUE REFERENCES order_items(id),
  event_id      uuid NOT NULL REFERENCES events(id),
  owner_id      uuid NOT NULL REFERENCES users(id),
  seat_id       bigint REFERENCES seats(id),
  zone_id       uuid NOT NULL REFERENCES zones(id),
  status        ticket_status NOT NULL DEFAULT 'valid',
  qr_version    integer NOT NULL DEFAULT 1,
  entered_at    timestamptz,
  gate          text,
  created_at    timestamptz NOT NULL DEFAULT app_now()
);
-- Second line of defence against selling a seat twice.
CREATE UNIQUE INDEX tickets_one_valid_per_seat_idx ON tickets (event_id, seat_id) WHERE status = 'valid' AND seat_id IS NOT NULL;
CREATE INDEX tickets_owner_idx ON tickets (owner_id, created_at DESC);
CREATE INDEX tickets_event_idx ON tickets (event_id, status);
CREATE INDEX tickets_order_idx ON tickets (order_id);

CREATE TABLE ticket_transfers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES tickets(id),
  from_user  uuid NOT NULL REFERENCES users(id),
  to_user    uuid NOT NULL REFERENCES users(id),
  qr_version integer NOT NULL,
  at         timestamptz NOT NULL DEFAULT app_now()
);
CREATE INDEX ticket_transfers_ticket_idx ON ticket_transfers (ticket_id);

CREATE TABLE ticket_scans (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id  uuid,
  event_id   uuid NOT NULL,
  scanner_id uuid NOT NULL,
  gate       text,
  result     text NOT NULL,
  reason     text,
  at         timestamptz NOT NULL DEFAULT app_now()
);
CREATE INDEX ticket_scans_event_idx ON ticket_scans (event_id, at);
CREATE INDEX ticket_scans_ticket_idx ON ticket_scans (ticket_id);

-- ---------------------------------------------------------------------------
-- Ledger (double entry; rules and triggers in the next migration)
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  kind       text NOT NULL CHECK (kind IN ('asset', 'liability', 'revenue')),
  balance    bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT app_now()
);

CREATE TABLE ledger_transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL,
  ref_id     uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  UNIQUE (kind, ref_id)
);

CREATE TABLE ledger_entries (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txn_id     uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount     bigint NOT NULL CHECK (amount <> 0),
  event_id   uuid,
  order_id   uuid,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
CREATE INDEX ledger_entries_txn_idx ON ledger_entries (txn_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at);
CREATE INDEX ledger_entries_order_idx ON ledger_entries (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE ledger_daily (
  account_id uuid NOT NULL REFERENCES accounts(id),
  day        date NOT NULL,
  debit      bigint NOT NULL DEFAULT 0,
  credit     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE sales_hourly (
  event_id         uuid NOT NULL REFERENCES events(id),
  zone_id          uuid NOT NULL REFERENCES zones(id),
  hour             timestamptz NOT NULL,
  organizer_id     uuid NOT NULL,
  tickets          integer NOT NULL DEFAULT 0,
  gross            bigint NOT NULL DEFAULT 0,
  fees             bigint NOT NULL DEFAULT 0,
  refunded_tickets integer NOT NULL DEFAULT 0,
  refunds          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, zone_id, hour)
);
CREATE INDEX sales_hourly_organizer_idx ON sales_hourly (organizer_id, hour);
CREATE INDEX sales_hourly_hour_idx ON sales_hourly (hour);

CREATE TABLE payouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL UNIQUE REFERENCES events(id),
  organizer_id uuid NOT NULL REFERENCES users(id),
  sales       bigint NOT NULL CHECK (sales >= 0),
  refunds     bigint NOT NULL CHECK (refunds >= 0),
  commission  bigint NOT NULL CHECK (commission >= 0),
  amount      bigint NOT NULL CHECK (amount >= 0),
  status      payout_status NOT NULL DEFAULT 'pending',
  due_at      timestamptz NOT NULL,
  executed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT app_now(),
  CHECK (amount = sales - refunds - commission)
);

-- ---------------------------------------------------------------------------
-- Queue, waitlist, tasks, emails
-- ---------------------------------------------------------------------------
CREATE SEQUENCE queue_seq;

CREATE TABLE queue_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  seq          bigint NOT NULL DEFAULT nextval('queue_seq'),
  status       queue_status NOT NULL DEFAULT 'waiting',
  joined_at    timestamptz NOT NULL DEFAULT app_now(),
  admitted_at  timestamptz,
  selecting_at timestamptz,
  finished_at  timestamptz,
  paid         boolean NOT NULL DEFAULT false,
  UNIQUE (event_id, user_id)
);
CREATE INDEX queue_entries_order_idx ON queue_entries (event_id, status, seq);

CREATE SEQUENCE waitlist_seq;

CREATE TABLE waitlist_entries (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id),
  zone_id   uuid REFERENCES zones(id),
  seq       bigint NOT NULL DEFAULT nextval('waitlist_seq'),
  status    waitlist_status NOT NULL DEFAULT 'waiting',
  created_at timestamptz NOT NULL DEFAULT app_now(),
  UNIQUE (event_id, user_id)
);
CREATE INDEX waitlist_entries_order_idx ON waitlist_entries (event_id, status, seq);

CREATE TABLE waitlist_offers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   uuid NOT NULL REFERENCES waitlist_entries(id),
  event_id   uuid NOT NULL REFERENCES events(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  seat_id    bigint REFERENCES seats(id),
  zone_id    uuid REFERENCES zones(id),
  status     offer_status NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
-- One offer at a time per event.
CREATE UNIQUE INDEX waitlist_one_active_offer_idx ON waitlist_offers (event_id) WHERE status = 'active';
CREATE INDEX waitlist_offers_expiry_idx ON waitlist_offers (expires_at) WHERE status = 'active';

-- Durable record of every scheduled/background task. BullMQ is only the executor; this table is the truth.
CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL,
  dedupe_key   text NOT NULL UNIQUE,
  payload      jsonb NOT NULL DEFAULT '{}',
  run_at       timestamptz NOT NULL DEFAULT app_now(),
  status       task_status NOT NULL DEFAULT 'pending',
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  last_error   text,
  lease_owner  text,
  lease_until  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT app_now(),
  updated_at   timestamptz NOT NULL DEFAULT app_now(),
  completed_at timestamptz
);
CREATE INDEX tasks_due_idx ON tasks (status, run_at) WHERE status IN ('pending', 'running');
CREATE INDEX tasks_failed_idx ON tasks (updated_at) WHERE status = 'failed';

CREATE TABLE emails (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  to_email   text NOT NULL,
  subject    text NOT NULL,
  template   text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  status     email_status NOT NULL DEFAULT 'pending',
  message_id text NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  sent_at    timestamptz
);

CREATE TABLE seed_state (
  key     text PRIMARY KEY,
  done_at timestamptz NOT NULL DEFAULT app_now()
);
