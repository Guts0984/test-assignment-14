-- The shop's own reference travels through the provider and comes back in refund webhooks.
ALTER TABLE stub_refunds ADD COLUMN reference text;

-- Differences between our books and the payment provider found by reconciliation.
CREATE TABLE recon_findings (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL,
  ref         text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  found_at    timestamptz NOT NULL DEFAULT app_now(),
  resolved_at timestamptz,
  UNIQUE (kind, ref)
);
CREATE INDEX recon_findings_open_idx ON recon_findings (found_at) WHERE resolved_at IS NULL;
