-- The payment stub behaves like an external provider; it keeps its own tables and never touches orders or the ledger.
CREATE TYPE stub_payment_status AS ENUM ('pending', 'succeeded', 'failed');
CREATE TYPE stub_refund_status  AS ENUM ('pending', 'succeeded', 'failed');
CREATE TYPE stub_webhook_status AS ENUM ('pending', 'sent', 'failed', 'dropped');

CREATE TABLE stub_payments (
  id              text PRIMARY KEY,
  amount          integer NOT NULL CHECK (amount > 0),
  order_ref       text NOT NULL,
  return_url      text,
  status          stub_payment_status NOT NULL DEFAULT 'pending',
  idempotency_key text NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  seq             integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT app_now(),
  updated_at      timestamptz NOT NULL DEFAULT app_now()
);
CREATE INDEX stub_payments_created_idx ON stub_payments (created_at);

CREATE TABLE stub_refunds (
  id              text PRIMARY KEY,
  payment_id      text NOT NULL REFERENCES stub_payments(id),
  amount          integer NOT NULL CHECK (amount > 0),
  status          stub_refund_status NOT NULL DEFAULT 'pending',
  idempotency_key text NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  seq             integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT app_now(),
  updated_at      timestamptz NOT NULL DEFAULT app_now()
);
CREATE INDEX stub_refunds_payment_idx ON stub_refunds (payment_id);

-- Delivery outbox: a webhook is a durable row until the dispatcher got a 2xx for it.
CREATE TABLE stub_webhooks (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_event_id text NOT NULL,
  kind              text NOT NULL,
  payload           jsonb NOT NULL,
  due_at            timestamptz NOT NULL,
  status            stub_webhook_status NOT NULL DEFAULT 'pending',
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  sent_at           timestamptz
);
CREATE INDEX stub_webhooks_due_idx ON stub_webhooks (due_at) WHERE status = 'pending';

CREATE TABLE stub_config (
  id    integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  chaos boolean
);
INSERT INTO stub_config DEFAULT VALUES;

CREATE SEQUENCE stub_request_seq;
CREATE SEQUENCE stub_chaos_seq;
