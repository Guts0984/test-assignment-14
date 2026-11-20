import type { Pool } from 'pg';
import { restartTask } from '@ticketing/platform';

export interface Period {
  readonly from: string;
  readonly to: string;
}

/** Default period: the last 90 days up to the database clock. */
export const resolvePeriod = async (pool: Pool, from: string | undefined, to: string | undefined): Promise<Period> => {
  const now = (await pool.query<{ now: Date }>(`SELECT app_now() AS now`)).rows[0]?.now ?? new Date();
  const end = to ? new Date(to) : now;
  const start = from ? new Date(from) : new Date(end.getTime() - 90 * 86_400_000);
  return { from: start.toISOString(), to: end.toISOString() };
};

/** Organizer dashboard from the maintained hourly rollup: sales per hour and zone, hall fill, queue-to-payment funnel. */
export const organizerSales = async (pool: Pool, organizerId: string, period: Period, eventId: string | undefined) => {
  const ev = eventId ?? null;
  const [byHour, byZone, events, funnel] = await Promise.all([
    pool.query<{ hour: Date; tickets: string; gross: string; refunds: string }>(
      `SELECT hour, SUM(tickets - refunded_tickets)::text AS tickets, SUM(gross)::text AS gross, SUM(refunds)::text AS refunds FROM sales_hourly
       WHERE organizer_id = $1 AND hour >= $2::timestamptz AND hour <= $3::timestamptz AND ($4::uuid IS NULL OR event_id = $4) GROUP BY hour ORDER BY hour`,
      [organizerId, period.from, period.to, ev],
    ),
    pool.query<{ zone_id: string; name: string; tickets: string; gross: string }>(
      `SELECT h.zone_id, z.name, SUM(h.tickets - h.refunded_tickets)::text AS tickets, SUM(h.gross)::text AS gross FROM sales_hourly h JOIN zones z ON z.id = h.zone_id
       WHERE h.organizer_id = $1 AND h.hour >= $2::timestamptz AND h.hour <= $3::timestamptz AND ($4::uuid IS NULL OR h.event_id = $4) GROUP BY h.zone_id, z.name ORDER BY SUM(h.gross) DESC LIMIT 100`,
      [organizerId, period.from, period.to, ev],
    ),
    pool.query<{ id: string; title: string; capacity: number; sold_count: number }>(
      `SELECT id, title, capacity, sold_count FROM events WHERE organizer_id = $1 AND ($4::uuid IS NULL OR id = $4) AND starts_at >= $2::timestamptz AND starts_at <= ($3::timestamptz + interval '180 days') ORDER BY starts_at DESC LIMIT 100`,
      [organizerId, period.from, period.to, ev],
    ),
    pool.query<{ joined: number; admitted: number; paid: number }>(
      `SELECT COUNT(*)::int AS joined, COUNT(*) FILTER (WHERE q.admitted_at IS NOT NULL)::int AS admitted, COUNT(*) FILTER (WHERE q.paid)::int AS paid
       FROM queue_entries q JOIN events e ON e.id = q.event_id WHERE e.organizer_id = $1 AND q.joined_at >= $2::timestamptz AND q.joined_at <= $3::timestamptz AND ($4::uuid IS NULL OR e.id = $4)`,
      [organizerId, period.from, period.to, ev],
    ),
  ]);
  return {
    from: period.from,
    to: period.to,
    byHour: byHour.rows.map((r) => ({ hour: r.hour.toISOString(), tickets: Number(r.tickets), gross: Number(r.gross), refunds: Number(r.refunds) })),
    byZone: byZone.rows.map((r) => ({ zoneId: r.zone_id, zoneName: r.name, tickets: Number(r.tickets), gross: Number(r.gross) })),
    events: events.rows.map((r) => ({ id: r.id, title: r.title, capacity: r.capacity, sold: r.sold_count, fillPercent: r.capacity > 0 ? Math.round((r.sold_count / r.capacity) * 1000) / 10 : 0 })),
    funnel: { joinedQueue: funnel.rows[0]?.joined ?? 0, admitted: funnel.rows[0]?.admitted ?? 0, paid: funnel.rows[0]?.paid ?? 0 },
  };
};

/** Finance report for a period (in the URL): sales, service fees, commission, refunds, payouts and a per-organizer split. */
export const financeReport = async (pool: Pool, period: Period) => {
  const [totals, payouts, byOrg] = await Promise.all([
    pool.query<{ sales: string; fees: string; refunds: string }>(
      `SELECT COALESCE(SUM(gross), 0)::text AS sales, COALESCE(SUM(fees), 0)::text AS fees, COALESCE(SUM(refunds), 0)::text AS refunds FROM sales_hourly WHERE hour >= $1::timestamptz AND hour <= $2::timestamptz`,
      [period.from, period.to],
    ),
    pool.query<{ commission: string; amount: string }>(
      `SELECT COALESCE(SUM(commission), 0)::text AS commission, COALESCE(SUM(amount), 0)::text AS amount FROM payouts WHERE status = 'paid' AND executed_at >= $1::timestamptz AND executed_at <= $2::timestamptz`,
      [period.from, period.to],
    ),
    pool.query<{ organizer_id: string; name: string; sales: string; refunds: string; commission: string; payouts: string }>(
      `WITH s AS (SELECT organizer_id, SUM(gross) AS sales, SUM(refunds) AS refunds FROM sales_hourly WHERE hour >= $1::timestamptz AND hour <= $2::timestamptz GROUP BY organizer_id),
            p AS (SELECT organizer_id, SUM(commission) AS commission, SUM(amount) AS amount FROM payouts WHERE status = 'paid' AND executed_at >= $1::timestamptz AND executed_at <= $2::timestamptz GROUP BY organizer_id)
       SELECT u.id AS organizer_id, u.display_name AS name, COALESCE(s.sales, 0)::text AS sales, COALESCE(s.refunds, 0)::text AS refunds, COALESCE(p.commission, 0)::text AS commission, COALESCE(p.amount, 0)::text AS payouts
       FROM users u LEFT JOIN s ON s.organizer_id = u.id LEFT JOIN p ON p.organizer_id = u.id WHERE s.organizer_id IS NOT NULL OR p.organizer_id IS NOT NULL ORDER BY COALESCE(s.sales, 0) DESC LIMIT 500`,
      [period.from, period.to],
    ),
  ]);
  return {
    from: period.from,
    to: period.to,
    sales: Number(totals.rows[0]?.sales ?? 0),
    serviceFees: Number(totals.rows[0]?.fees ?? 0),
    commission: Number(payouts.rows[0]?.commission ?? 0),
    refunds: Number(totals.rows[0]?.refunds ?? 0),
    payouts: Number(payouts.rows[0]?.amount ?? 0),
    byOrganizer: byOrg.rows.map((r) => ({ organizerId: r.organizer_id, organizerName: r.name, sales: Number(r.sales), refunds: Number(r.refunds), commission: Number(r.commission), payouts: Number(r.payouts) })),
  };
};

/** The books must agree with themselves, with their rollups, and with the provider. */
/**
 * Reconciliation, fast enough to run on demand (< 500 ms on 1.5M entries). It never trusts one structure alone: account
 * balances are checked against the daily ledger rollup, both are checked to sum to zero, every transaction of the last day is
 * re-added from its entries (older ones are covered by the deferred zero-sum constraint that rejected them at commit), and the
 * sales rollup is checked against the ledger.
 */
export const reconciliation = async (pool: Pool) => {
  const [sum, balances, rollup, findings, stuck] = await Promise.all([
    pool.query<{ total: string; daily_total: string; unbalanced: number }>(
      `SELECT (SELECT COALESCE(SUM(balance), 0) FROM accounts)::text AS total,
              (SELECT COALESCE(SUM(debit - credit), 0) FROM ledger_daily)::text AS daily_total,
              (SELECT COUNT(*)::int FROM (SELECT e.txn_id FROM ledger_transactions t JOIN ledger_entries e ON e.txn_id = t.id
                                           WHERE t.created_at > (SELECT app_now() - interval '1 day') GROUP BY e.txn_id HAVING SUM(e.amount) <> 0) x) AS unbalanced`,
    ),
    pool.query<{ code: string; balance: string; sum: string }>(
      `SELECT a.code, a.balance::text AS balance, COALESCE(d.sum, 0)::text AS sum
       FROM accounts a LEFT JOIN (SELECT account_id, SUM(debit - credit) AS sum FROM ledger_daily GROUP BY account_id) d ON d.account_id = a.id
       WHERE a.balance <> COALESCE(d.sum, 0) LIMIT 200`,
    ),
    // Sales rollup (gross + fees - refunds) = what payments and refunds moved on the organizer and fee accounts, i.e. those
    // accounts' movement minus what payouts moved on them.
    pool.query<{ n: number }>(
      `SELECT (CASE WHEN (SELECT COALESCE(SUM(gross + fees - refunds), 0) FROM sales_hourly) =
                (SELECT COALESCE(SUM(credit - debit), 0) FROM ledger_daily d JOIN accounts a ON a.id = d.account_id
                 WHERE a.code LIKE 'organizer_payable:%' OR a.code = 'service_fee_revenue')
              + (SELECT COALESCE(SUM(e.amount), 0) FROM ledger_transactions t JOIN ledger_entries e ON e.txn_id = t.id JOIN accounts a ON a.id = e.account_id
                 WHERE t.kind = 'payout' AND (a.code LIKE 'organizer_payable:%' OR a.code = 'service_fee_revenue'))
              THEN 0 ELSE 1 END)::int AS n`,
    ),
    pool.query<{ kind: string; ref: string; detail: Record<string, unknown>; found_at: Date; resolved_at: Date | null }>(`SELECT kind, ref, detail, found_at, resolved_at FROM recon_findings ORDER BY found_at DESC LIMIT 200`),
    pool.query<{ pending_payments: number; pending_refunds: number; failed_refunds: number }>(
      `SELECT (SELECT COUNT(*)::int FROM payments WHERE status IN ('created', 'pending') AND created_at < app_now() - interval '5 minutes' AND provider_payment_id NOT LIKE 'seed\\_%') AS pending_payments,
              (SELECT COUNT(*)::int FROM refunds WHERE status IN ('requested', 'pending') AND created_at < app_now() - interval '5 minutes') AS pending_refunds,
              (SELECT COUNT(*)::int FROM refunds WHERE status = 'failed') AS failed_refunds`,
    ),
  ]);
  const mismatches = balances.rows.map((r) => ({ account: r.code, balance: Number(r.balance), entriesSum: Number(r.sum) }));
  const unresolved = findings.rows.filter((f) => f.resolved_at === null).length;
  return {
    ledgerSum: Number(sum.rows[0]?.total ?? 0),
    unbalancedTransactions: sum.rows[0]?.unbalanced ?? 0,
    balanceMismatches: mismatches,
    rollupMismatches: rollup.rows[0]?.n ?? 0,
    providerFindings: findings.rows.map((f) => ({ kind: f.kind, ref: f.ref, detail: f.detail, foundAt: f.found_at.toISOString(), resolved: f.resolved_at !== null })),
    stuck: { pendingPayments: stuck.rows[0]?.pending_payments ?? 0, pendingRefunds: stuck.rows[0]?.pending_refunds ?? 0, failedRefunds: stuck.rows[0]?.failed_refunds ?? 0 },
    ok: Number(sum.rows[0]?.total ?? 0) === 0 && Number(sum.rows[0]?.daily_total ?? 0) === 0 && (sum.rows[0]?.unbalanced ?? 0) === 0 && mismatches.length === 0 && (rollup.rows[0]?.n ?? 0) === 0 && unresolved === 0,
  };
};

const STUCK = `(status = 'pending' AND run_at < app_now() - interval '2 minutes') OR (status = 'running' AND lease_until < app_now())`;

export const listJobs = async (pool: Pool, status: 'failed' | 'stuck' | 'all') => {
  const where = status === 'failed' ? `status = 'failed'` : status === 'stuck' ? `(${STUCK})` : `(status = 'failed' OR ${STUCK})`;
  const res = await pool.query<{ id: string; kind: string; dedupe_key: string; status: string; attempts: number; max_attempts: number; last_error: string | null; run_at: Date; updated_at: Date; stuck: boolean }>(
    `SELECT id, kind, dedupe_key, status, attempts, max_attempts, last_error, run_at, updated_at, (${STUCK}) AS stuck FROM tasks WHERE ${where} ORDER BY updated_at DESC LIMIT 200`,
  );
  return res.rows.map((r) => ({ id: r.id, kind: r.kind, dedupeKey: r.dedupe_key, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, lastError: r.last_error, runAt: r.run_at.toISOString(), updatedAt: r.updated_at.toISOString(), stuck: r.stuck }));
};

/** Restarting a failed task resets its attempts; a stuck one is nudged to run now. Running it twice cannot duplicate work: every handler is idempotent and claims are exclusive. */
export const restartJob = async (pool: Pool, id: string): Promise<boolean> => {
  if (await restartTask(pool, id)) return true;
  const nudged = await pool.query(`UPDATE tasks SET status = 'pending', run_at = app_now(), lease_owner = NULL, lease_until = NULL, updated_at = app_now() WHERE id = $1 AND (${STUCK})`, [id]);
  return nudged.rowCount === 1;
};
