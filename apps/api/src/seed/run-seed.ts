import type { Pool, PoolClient } from 'pg';
import type { SeedParams } from './params.js';
import { EVENTS_SQL, TICKET_PLAN_SQL, TICKET_PRICING_SQL, TIERS_SQL } from './stages/events.js';
import {
  ACCOUNTS_SQL,
  PAUSE_TRIGGERS_SQL,
  PAYMENT_LEDGER_SQL,
  PAYOUTS_SQL,
  REFUND_LEDGER_SQL,
  RESUME_TRIGGERS_SQL,
  ROLLUP_SQL,
  VERIFY_SQL,
} from './stages/ledger.js';
import { BUYERS_SQL, CONFIG_SQL, USERS_SQL, VENUES_SQL, ZONES_SQL } from './stages/people-and-halls.js';
import { ORDERS_SQL, REFUNDS_SQL, SEATS_SQL } from './stages/sales.js';

export const SEED_MARKER = 'seed_v1';
const SEED_LOCK = 7_300_001;

export type SeedLog = (line: string) => void;

export type SeedResult = { readonly skipped: true } | { readonly skipped: false; readonly tickets: number; readonly millis: number };

/** Runs one named stage; failures say which stage broke. */
const stage = async (client: PoolClient, name: string, sql: string, log: SeedLog): Promise<void> => {
  const started = Date.now();
  try {
    await client.query(sql);
    log(`seed: ${name} ${Date.now() - started} ms`);
  } catch (error) {
    throw new Error(`seed stage "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const count = async (client: PoolClient, sql: string): Promise<number> => {
  const res = await client.query(sql);
  return Number((res.rows[0] as { n: string }).n);
};

/** Scales the planned sales per event so that the grand total is exactly `params.tickets`. */
const scaleSales = async (client: PoolClient, params: SeedParams): Promise<void> => {
  const base = await client.query(
    `SELECT COALESCE(SUM(sold) FILTER (WHERE is_full), 0)::bigint AS full_sold, COALESCE(SUM(w), 0)::float8 AS sum_w FROM seed_events`,
  );
  const { full_sold: fullSold, sum_w: sumW } = base.rows[0] as { full_sold: string; sum_w: number };
  const target = params.tickets - Number(fullSold);
  if (target < 0 || sumW <= 0) throw new Error('seed parameters leave no room for ticket sales');
  await client.query(
    `UPDATE seed_events SET sold = LEAST(capacity, GREATEST(1, FLOOR(w * $1::numeric / $2::numeric)::int)) WHERE has_sales AND NOT is_full`,
    [target, sumW],
  );
  for (let round = 0; round < 40; round += 1) {
    const remaining = params.tickets - (await count(client, `SELECT COALESCE(SUM(sold), 0)::bigint AS n FROM seed_events`));
    if (remaining === 0) return;
    if (remaining > 0) {
      await client.query(
        `UPDATE seed_events SET sold = sold + 1 WHERE id IN (SELECT id FROM seed_events WHERE has_sales AND NOT is_full AND sold < capacity ORDER BY idx LIMIT $1)`,
        [remaining],
      );
    } else {
      await client.query(
        `UPDATE seed_events SET sold = sold - 1 WHERE id IN (SELECT id FROM seed_events WHERE has_sales AND NOT is_full AND sold > 1 ORDER BY idx LIMIT $1)`,
        [-remaining],
      );
    }
  }
  throw new Error('could not reach the exact ticket total');
};

/**
 * Builds the whole data set in one transaction with set-based SQL. Idempotent: a marker row makes a
 * second run a no-op, and an advisory lock serialises concurrent starters (several containers).
 */
export const runSeed = async (pool: Pool, params: SeedParams, passwordHash: string, log: SeedLog = () => undefined): Promise<SeedResult> => {
  const client = await pool.connect();
  const started = Date.now();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SEED_LOCK]);
    const done = await client.query('SELECT 1 FROM seed_state WHERE key = $1', [SEED_MARKER]);
    if (done.rowCount === 1) return { skipped: true };

    await client.query('BEGIN');
    await client.query(`SET LOCAL synchronous_commit = off`);
    await client.query(`SET LOCAL work_mem = '256MB'`);
    // Bulk load: skip per-row FK checks (verified afterwards by the seed test) when the role may do so.
    await client.query(`SET LOCAL session_replication_role = replica`).catch(() => undefined);
    await client.query(CONFIG_SQL, [
      params.users, params.organizers, params.scanners, params.finance, params.venues, params.events, params.tickets,
      params.arenaSeats, params.arenaFloor, params.venueMinSeats, params.venueMaxSeats, params.soonMod, params.arenaMod, passwordHash,
    ]);
    for (const [name, sql] of [['users', USERS_SQL], ['buyers', BUYERS_SQL], ['venues', VENUES_SQL], ['zones', ZONES_SQL], ['events', EVENTS_SQL], ['tiers', TIERS_SQL]] as const) await stage(client, name, sql, log);
    await scaleSales(client, params);
    for (const [name, sql] of [['ticket plan', TICKET_PLAN_SQL], ['ticket pricing', TICKET_PRICING_SQL], ['orders', ORDERS_SQL], ['refunds', REFUNDS_SQL], ['seats', SEATS_SQL]] as const) await stage(client, name, sql, log);
    await stage(client, 'pause triggers', PAUSE_TRIGGERS_SQL, log);
    for (const [name, sql] of [['accounts', ACCOUNTS_SQL], ['payment ledger', PAYMENT_LEDGER_SQL], ['refund ledger', REFUND_LEDGER_SQL], ['payouts', PAYOUTS_SQL], ['rollups', ROLLUP_SQL]] as const) await stage(client, name, sql, log);
    await stage(client, 'resume triggers', RESUME_TRIGGERS_SQL, log);
    const verify = (await client.query(VERIFY_SQL)).rows[0] as { total: string; unbalanced: number };
    if (verify.total !== '0' || verify.unbalanced !== 0) throw new Error(`seed ledger is not balanced: ${JSON.stringify(verify)}`);
    await client.query('INSERT INTO seed_state (key) VALUES ($1)', [SEED_MARKER]);
    await client.query('COMMIT');
    return { skipped: false, tickets: await count(client, 'SELECT COUNT(*)::bigint AS n FROM tickets'), millis: Date.now() - started };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SEED_LOCK]).catch(() => undefined);
    client.release();
  }
};
