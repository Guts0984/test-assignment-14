-- Reconciliation re-checks the balance of recent ledger transactions; find them without scanning the whole journal.
CREATE INDEX IF NOT EXISTS ledger_transactions_created_idx ON ledger_transactions (created_at);
