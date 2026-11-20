import type { Pool, PoolClient } from 'pg';
import { RULES, estimateWaitSeconds } from '@ticketing/shared';
import { withTx } from '../db/types.js';

export type QueueStatus = 'waiting' | 'admitted' | 'selecting' | 'done' | 'expired' | 'left';

export interface QueueConfig {
  /** Queue mode turns on when more people than this claim the event at once. */
  readonly activateAt: number;
  /** At most this many people may pick seats at the same time (in queue mode). */
  readonly maxSelecting: number;
  /** An admitted person who did not start selecting within this time loses the slot. */
  readonly startSelectionMs: number;
  /** A selecting person keeps the slot for at most this long (the hold lifetime). */
  readonly holdTtlMs: number;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = Object.freeze({
  activateAt: RULES.queueActivateAt,
  maxSelecting: RULES.queueMaxSelecting,
  startSelectionMs: RULES.queueStartSelectionMs,
  holdTtlMs: RULES.holdTtlMs,
});

export interface QueueView {
  readonly status: QueueStatus;
  /** 1-based place among the waiting; null when not waiting. */
  readonly position: number | null;
  readonly etaSeconds: number | null;
  /** Until when an admitted person may start selecting (server time). */
  readonly mustStartBefore: Date | null;
  readonly queueActive: boolean;
}

interface EntryRow {
  id: string;
  seq: string;
  status: QueueStatus;
  admitted_at: Date | null;
}

const lockKey = (eventId: string): string => `queue:${eventId}`;
const ms = (value: number): number => value;

/** Slots held by people who are admitted or selecting and have not timed out (decided by the database clock). */
const COUNT_ACTIVE_SQL = `
  SELECT COUNT(*)::int AS n FROM queue_entries
  WHERE event_id = $1 AND (
    (status = 'admitted' AND admitted_at > app_now() - make_interval(secs => $2::float8 / 1000.0)) OR
    (status = 'selecting' AND selecting_at > app_now() - make_interval(secs => $3::float8 / 1000.0)))`;

const expireStale = async (tx: PoolClient, eventId: string, cfg: QueueConfig): Promise<void> => {
  await tx.query(
    `UPDATE queue_entries SET status = 'expired', finished_at = app_now()
     WHERE event_id = $1 AND status = 'admitted' AND admitted_at <= app_now() - make_interval(secs => $2::float8 / 1000.0)`,
    [eventId, ms(cfg.startSelectionMs)],
  );
  await tx.query(
    `UPDATE queue_entries SET status = 'done', finished_at = app_now()
     WHERE event_id = $1 AND status = 'selecting' AND selecting_at <= app_now() - make_interval(secs => $2::float8 / 1000.0)`,
    [eventId, ms(cfg.holdTtlMs)],
  );
};

/** Admits the next waiting people in join order, never exceeding the selecting capacity. Caller holds the event lock. */
const admitInTx = async (tx: PoolClient, eventId: string, cfg: QueueConfig): Promise<readonly string[]> => {
  await expireStale(tx, eventId, cfg);
  const active = (await tx.query<{ n: number }>(COUNT_ACTIVE_SQL, [eventId, cfg.startSelectionMs, cfg.holdTtlMs])).rows[0]?.n ?? 0;
  const free = Math.max(0, cfg.maxSelecting - active);
  if (free === 0) return [];
  const admitted = await tx.query<{ user_id: string }>(
    `UPDATE queue_entries SET status = 'admitted', admitted_at = app_now()
     WHERE id IN (SELECT id FROM queue_entries WHERE event_id = $1 AND status = 'waiting' ORDER BY seq LIMIT $2 FOR UPDATE)
     RETURNING user_id`,
    [eventId, free],
  );
  return admitted.rows.map((r) => r.user_id);
};

const releaseModeIfIdle = async (tx: PoolClient, eventId: string): Promise<void> => {
  await tx.query(
    `UPDATE events SET queue_active = false
     WHERE id = $1 AND queue_active AND NOT EXISTS (SELECT 1 FROM queue_entries WHERE event_id = $1 AND status IN ('waiting', 'admitted', 'selecting'))`,
    [eventId],
  );
};

export interface QueueCacheHooks {
  readonly onJoined: (eventId: string, userId: string, seq: number) => Promise<void>;
  readonly onLeft: (eventId: string, userIds: readonly string[]) => Promise<void>;
  readonly position: (eventId: string, userId: string) => Promise<number | null>;
  readonly rebuild: (eventId: string, waiting: readonly { userId: string; seq: number }[]) => Promise<void>;
}

/**
 * The virtual queue. Postgres decides everything (order, capacity, who is admitted); the optional cache only
 * speeds up reads and is rebuilt from Postgres whenever it is empty, so losing it loses nothing.
 */
export const createVirtualQueue = (deps: { readonly pool: Pool; readonly cfg?: QueueConfig; readonly cache?: QueueCacheHooks }) => {
  const cfg = deps.cfg ?? DEFAULT_QUEUE_CONFIG;
  const { pool, cache } = deps;

  const waitingFor = async (eventId: string): Promise<readonly { userId: string; seq: number }[]> => {
    const res = await pool.query<{ user_id: string; seq: string }>(
      `SELECT user_id, seq FROM queue_entries WHERE event_id = $1 AND status = 'waiting' ORDER BY seq`,
      [eventId],
    );
    return res.rows.map((r) => ({ userId: r.user_id, seq: Number(r.seq) }));
  };

  const view = async (eventId: string, userId: string): Promise<QueueView | null> => {
    const res = await pool.query<{ status: QueueStatus; seq: string; admitted_at: Date | null; queue_active: boolean; ahead: number; recent: number }>(
      `SELECT q.status, q.seq, q.admitted_at, e.queue_active,
              (SELECT COUNT(*)::int FROM queue_entries w WHERE w.event_id = q.event_id AND w.status = 'waiting' AND w.seq < q.seq) AS ahead,
              (SELECT COUNT(*)::int FROM queue_entries a WHERE a.event_id = q.event_id AND a.admitted_at > app_now() - interval '5 minutes') AS recent
       FROM queue_entries q JOIN events e ON e.id = q.event_id WHERE q.event_id = $1 AND q.user_id = $2`,
      [eventId, userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    let position: number | null = null;
    if (row.status === 'waiting') {
      const cached = cache ? await cache.position(eventId, userId).catch(() => null) : null;
      if (cached !== null) position = cached;
      else {
        position = row.ahead + 1;
        if (cache) await cache.rebuild(eventId, await waitingFor(eventId)).catch(() => undefined);
      }
    }
    return {
      status: row.status,
      position,
      etaSeconds: position === null ? null : estimateWaitSeconds({ position, admittedInWindow: row.recent, windowSeconds: 300 }),
      mustStartBefore: row.status === 'admitted' && row.admitted_at ? new Date(row.admitted_at.getTime() + cfg.startSelectionMs) : null,
      queueActive: row.queue_active,
    };
  };

  /** Idempotent: a second call (reload, second tab, other api copy) returns the existing place. */
  const join = async (eventId: string, userId: string): Promise<QueueView> => {
    const joined = await withTx(pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(eventId)]);
      const existing = (await tx.query<EntryRow>(`SELECT id, seq, status, admitted_at FROM queue_entries WHERE event_id = $1 AND user_id = $2 FOR UPDATE`, [eventId, userId])).rows[0];
      if (existing && ['waiting', 'admitted', 'selecting'].includes(existing.status)) return { fresh: false as const, seq: Number(existing.seq) };

      const ev = (await tx.query<{ queue_active: boolean; claimants: number }>(
        `SELECT e.queue_active, (SELECT COUNT(*)::int FROM queue_entries q WHERE q.event_id = e.id AND q.status IN ('waiting', 'admitted', 'selecting')) AS claimants
         FROM events e WHERE e.id = $1 FOR UPDATE`,
        [eventId],
      )).rows[0];
      if (!ev) throw new Error(`event ${eventId} not found`);
      let active = ev.queue_active;
      // Below the activation threshold people walk straight in, but never more than the selection capacity at once:
      // a burst that fills every slot turns the queue on early instead of letting the (cap + 1)-th person through.
      const selectingNow = active ? 0 : ((await tx.query<{ n: number }>(COUNT_ACTIVE_SQL, [eventId, cfg.startSelectionMs, cfg.holdTtlMs])).rows[0]?.n ?? 0);
      if (!active && (ev.claimants + 1 > cfg.activateAt || selectingNow >= cfg.maxSelecting)) {
        await tx.query(`UPDATE events SET queue_active = true WHERE id = $1`, [eventId]);
        active = true;
      }
      const status: QueueStatus = active ? 'waiting' : 'admitted';
      const row = (await tx.query<EntryRow>(
        existing
          ? `UPDATE queue_entries SET seq = nextval('queue_seq'), status = $3::queue_status, joined_at = app_now(),
                    admitted_at = CASE WHEN $3 = 'admitted' THEN app_now() END, selecting_at = NULL, finished_at = NULL, paid = false
             WHERE event_id = $1 AND user_id = $2 RETURNING id, seq, status, admitted_at`
          : `INSERT INTO queue_entries (event_id, user_id, status, admitted_at) VALUES ($1, $2, $3::queue_status, CASE WHEN $3 = 'admitted' THEN app_now() END)
             RETURNING id, seq, status, admitted_at`,
        [eventId, userId, status],
      )).rows[0];
      const admittedNow = active ? await admitInTx(tx, eventId, cfg) : [];
      return { fresh: true as const, seq: Number(row?.seq ?? 0), admittedNow };
    });
    if (cache && joined.fresh) {
      await cache.onJoined(eventId, userId, joined.seq).catch(() => undefined);
      await cache.onLeft(eventId, joined.admittedNow).catch(() => undefined);
    }
    const current = await view(eventId, userId);
    if (!current) throw new Error('queue entry vanished');
    return current;
  };

  /** One admission round. Safe to call from any api copy or worker, concurrently: capacity is enforced inside the lock. */
  const admit = async (eventId: string): Promise<readonly string[]> => {
    const admitted = await withTx(pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(eventId)]);
      const people = await admitInTx(tx, eventId, cfg);
      await releaseModeIfIdle(tx, eventId);
      return people;
    });
    if (cache) await cache.onLeft(eventId, admitted).catch(() => undefined);
    return admitted;
  };

  /** Called when the person creates their first hold. Only an admitted, non-timed-out person may start. */
  const startSelecting = async (eventId: string, userId: string): Promise<'ok' | 'not_admitted'> => {
    const res = await pool.query(
      `UPDATE queue_entries SET status = 'selecting', selecting_at = app_now()
       WHERE event_id = $1 AND user_id = $2 AND status = 'admitted' AND admitted_at > app_now() - make_interval(secs => $3::float8 / 1000.0)`,
      [eventId, userId, cfg.startSelectionMs],
    );
    if (res.rowCount === 1) return 'ok';
    const already = await pool.query(
      `SELECT 1 FROM queue_entries WHERE event_id = $1 AND user_id = $2 AND status = 'selecting' AND selecting_at > app_now() - make_interval(secs => $3::float8 / 1000.0)`,
      [eventId, userId, cfg.holdTtlMs],
    );
    return already.rowCount === 1 ? 'ok' : 'not_admitted';
  };

  /** The person paid, abandoned or their hold ended: free the slot and let the next one in. */
  const finish = async (eventId: string, userId: string, outcome: { readonly paid: boolean }): Promise<void> => {
    await pool.query(
      `UPDATE queue_entries SET status = 'done', finished_at = app_now(), paid = paid OR $3
       WHERE event_id = $1 AND user_id = $2 AND status IN ('admitted', 'selecting')`,
      [eventId, userId, outcome.paid],
    );
  };

  const leave = async (eventId: string, userId: string): Promise<void> => {
    await pool.query(`UPDATE queue_entries SET status = 'left', finished_at = app_now() WHERE event_id = $1 AND user_id = $2 AND status IN ('waiting', 'admitted', 'selecting')`, [eventId, userId]);
    if (cache) await cache.onLeft(eventId, [userId]).catch(() => undefined);
  };

  /** True when the event is in queue mode and this person has no valid slot. */
  const mustWait = async (eventId: string, userId: string): Promise<boolean> => {
    const res = await pool.query<{ queue_active: boolean; ok: boolean }>(
      `SELECT e.queue_active, EXISTS (
         SELECT 1 FROM queue_entries q WHERE q.event_id = e.id AND q.user_id = $2 AND (
           (q.status = 'admitted' AND q.admitted_at > app_now() - make_interval(secs => $3::float8 / 1000.0)) OR
           (q.status = 'selecting' AND q.selecting_at > app_now() - make_interval(secs => $4::float8 / 1000.0)))) AS ok
       FROM events e WHERE e.id = $1`,
      [eventId, userId, cfg.startSelectionMs, cfg.holdTtlMs],
    );
    const row = res.rows[0];
    return row ? row.queue_active && !row.ok : false;
  };

  const rebuildCache = async (eventId: string): Promise<number> => {
    const waiting = await waitingFor(eventId);
    if (cache) await cache.rebuild(eventId, waiting);
    return waiting.length;
  };

  const activeCount = async (eventId: string): Promise<number> =>
    (await pool.query<{ n: number }>(COUNT_ACTIVE_SQL, [eventId, cfg.startSelectionMs, cfg.holdTtlMs])).rows[0]?.n ?? 0;

  return Object.freeze({ join, view, admit, startSelecting, finish, leave, mustWait, rebuildCache, activeCount });
};

export type VirtualQueue = ReturnType<typeof createVirtualQueue>;
