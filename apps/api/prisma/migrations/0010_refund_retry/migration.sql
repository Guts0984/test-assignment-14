-- A refund the provider rejected is a debt, not a closed case: finance retries it, each retry being a new attempt at the
-- provider (new idempotency key), so the earlier rejection is not simply replayed.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS provider_attempt integer NOT NULL DEFAULT 0 CHECK (provider_attempt >= 0);

-- A rejected refund keeps its tickets, so no second refund can be created for the same ticket while the first is owed.
-- Earlier versions let them go; take them back unless a newer refund already uses the ticket.
UPDATE refund_items ri SET active = true
FROM refunds r
WHERE r.id = ri.refund_id AND r.status = 'failed' AND NOT ri.active
  AND NOT EXISTS (SELECT 1 FROM refund_items o WHERE o.order_item_id = ri.order_item_id AND o.active);

CREATE INDEX IF NOT EXISTS refunds_failed_idx ON refunds (updated_at) WHERE status = 'failed';
