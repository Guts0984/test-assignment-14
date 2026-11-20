/** Stage 4: ledger entries, payouts, rollups. Triggers are paused during the bulk load and the result is verified afterwards. */

export const PAUSE_TRIGGERS_SQL = `
ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_apply;
ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_balanced;
ALTER TABLE accounts DISABLE TRIGGER accounts_guard`;

export const RESUME_TRIGGERS_SQL = `
ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_apply;
ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_balanced;
ALTER TABLE accounts ENABLE TRIGGER accounts_guard`;

export const ACCOUNTS_SQL = `
INSERT INTO accounts (code, kind) VALUES
  ('provider_cash', 'asset'), ('service_fee_revenue', 'revenue'), ('commission_revenue', 'revenue'), ('payout_cash', 'asset')
ON CONFLICT (code) DO NOTHING;
INSERT INTO accounts (code, kind) SELECT 'organizer_payable:' || id, 'liability' FROM seed_orgs ON CONFLICT (code) DO NOTHING`;

export const PAYMENT_LEDGER_SQL = `
INSERT INTO ledger_transactions (id, kind, ref_id, created_at)
SELECT md5('lt' || order_id)::uuid, 'payment', md5('p' || order_id)::uuid, paid_at FROM seed_orders;
INSERT INTO ledger_entries (txn_id, account_id, amount, event_id, order_id, created_at)
SELECT md5('lt' || o.order_id)::uuid, a.id, x.amount, o.event_id, o.order_id, o.paid_at
FROM seed_orders o
CROSS JOIN LATERAL (VALUES
  ('provider_cash', o.total::bigint), ('organizer_payable:' || o.organizer_id, -o.subtotal::bigint), ('service_fee_revenue', -o.fee::bigint)
) x(code, amount)
JOIN accounts a ON a.code = x.code`;

export const REFUND_LEDGER_SQL = `
INSERT INTO ledger_transactions (id, kind, ref_id, created_at)
SELECT md5('lt' || r.id)::uuid, 'refund', r.id, r.created_at FROM refunds r WHERE r.reason = 'seed';
INSERT INTO ledger_entries (txn_id, account_id, amount, event_id, order_id, created_at)
SELECT md5('lt' || r.id)::uuid, a.id, x.amount, o.event_id, r.order_id, r.created_at
FROM refunds r JOIN seed_orders o ON o.order_id = r.order_id
CROSS JOIN LATERAL (VALUES ('organizer_payable:' || o.organizer_id, r.price_amount::bigint), ('provider_cash', -r.price_amount::bigint)) x(code, amount)
JOIN accounts a ON a.code = x.code
WHERE r.reason = 'seed'`;

export const PAYOUTS_SQL = `
CREATE TEMP TABLE seed_payout_calc ON COMMIT DROP AS
SELECT e.id AS event_id, e.organizer_id, e.starts_at,
       COALESCE(SUM(i.price) , 0)::bigint AS sales,
       COALESCE(SUM(i.price) FILTER (WHERE i.refunded), 0)::bigint AS refunds
FROM seed_events e JOIN seed_items i ON i.event_id = e.id
WHERE e.starts_at < (SELECT anchor - interval '3 days' FROM seed_cfg) AND e.has_sales
GROUP BY e.id, e.organizer_id, e.starts_at;
INSERT INTO payouts (id, event_id, organizer_id, sales, refunds, commission, amount, status, due_at, executed_at, created_at)
SELECT md5('po' || event_id)::uuid, event_id, organizer_id, sales, refunds, ((sales - refunds) * 8) / 100,
       (sales - refunds) - ((sales - refunds) * 8) / 100, 'paid', starts_at + interval '3 days', starts_at + interval '3 days', starts_at + interval '3 days'
FROM seed_payout_calc;
INSERT INTO ledger_transactions (id, kind, ref_id, created_at)
SELECT md5('lt' || p.id)::uuid, 'payout', p.id, p.executed_at FROM payouts p;
INSERT INTO ledger_entries (txn_id, account_id, amount, event_id, created_at)
SELECT md5('lt' || p.id)::uuid, a.id, x.amount, p.event_id, p.executed_at
FROM payouts p
CROSS JOIN LATERAL (VALUES
  ('organizer_payable:' || p.organizer_id, (p.sales - p.refunds)::bigint), ('commission_revenue', -p.commission), ('payout_cash', -p.amount)
) x(code, amount)
JOIN accounts a ON a.code = x.code
WHERE x.amount <> 0`;

export const ROLLUP_SQL = `
UPDATE accounts a SET balance = s.total FROM (SELECT account_id, SUM(amount) AS total FROM ledger_entries GROUP BY 1) s WHERE s.account_id = a.id;
INSERT INTO ledger_daily (account_id, day, debit, credit)
SELECT account_id, (created_at AT TIME ZONE 'UTC')::date, SUM(GREATEST(amount, 0)), SUM(GREATEST(-amount, 0))
FROM ledger_entries GROUP BY 1, 2;
INSERT INTO sales_hourly (event_id, zone_id, hour, organizer_id, tickets, gross, fees, refunded_tickets, refunds)
SELECT event_id, zone_id, hour, organizer_id, SUM(tickets), SUM(gross), SUM(fees), SUM(refunded_tickets), SUM(refunds) FROM (
  SELECT i.event_id, i.zone_id, date_trunc('hour', i.paid_at) AS hour, i.organizer_id, 1 AS tickets, i.price::bigint AS gross, i.fee::bigint AS fees, 0 AS refunded_tickets, 0::bigint AS refunds
  FROM seed_items i
  UNION ALL
  SELECT i.event_id, i.zone_id, date_trunc('hour', r.created_at), i.organizer_id, 0, 0, 0, 1, i.price::bigint
  FROM seed_items i JOIN refunds r ON r.id = md5('r' || i.item_id)::uuid WHERE i.refunded
) x GROUP BY event_id, zone_id, hour, organizer_id`;

export const VERIFY_SQL = `
SELECT
  (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries)::text AS total,
  (SELECT COUNT(*) FROM (SELECT txn_id FROM ledger_entries GROUP BY txn_id HAVING SUM(amount) <> 0) x)::int AS unbalanced`;
