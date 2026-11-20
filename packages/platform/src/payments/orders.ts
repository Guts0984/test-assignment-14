import type { PoolClient } from 'pg';

export interface LockedOrder {
  readonly id: string;
  readonly user_id: string;
  readonly event_id: string;
  readonly status: 'holding' | 'awaiting_payment' | 'paid' | 'expired' | 'partially_refunded' | 'refunded';
  readonly expired: boolean;
  readonly promo_id: string | null;
  readonly promo_held: boolean;
  readonly total: number;
}

export const lockOrder = async (tx: PoolClient, orderId: string): Promise<LockedOrder | null> => {
  const res = await tx.query<LockedOrder>(
    `SELECT id, user_id, event_id, status, (hold_expires_at IS NULL OR hold_expires_at <= app_now()) AS expired, promo_id, promo_held, total FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  return res.rows[0] ?? null;
};

export const history = (tx: PoolClient, orderId: string, role: string, actorId: string | null, type: string, data: unknown = {}): Promise<unknown> =>
  tx.query(`INSERT INTO order_history (order_id, actor_id, actor_role, type, data) VALUES ($1, $2, $3, $4, $5::jsonb)`, [orderId, actorId, role, type, JSON.stringify(data)]);

/** A task that must exist once this transaction commits (emails, expiry, ...). Idempotent per dedupe key. */
export const enqueue = (tx: PoolClient, kind: string, dedupeKey: string, payload: unknown, delayMs = 0): Promise<unknown> =>
  tx.query(
    `INSERT INTO tasks (kind, dedupe_key, payload, run_at) VALUES ($1, $2, $3::jsonb, app_now() + make_interval(secs => $4::float8 / 1000.0)) ON CONFLICT (dedupe_key) DO NOTHING`,
    [kind, dedupeKey, JSON.stringify(payload), delayMs],
  );

/**
 * Event-level lock shared by everything that sells, refunds or transfers (shared mode) and exclusively taken by
 * cancellation: a cancel waits for in-flight operations, and nothing new starts until it commits.
 */
export const lockEvent = (tx: PoolClient, eventId: string, shared: boolean): Promise<unknown> =>
  tx.query(`SELECT pg_advisory_xact_${shared ? 'lock_shared' : 'lock'}(hashtextextended($1, 0))`, [`event:${eventId}`]);
