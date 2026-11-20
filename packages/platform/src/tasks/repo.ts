import type { Db } from '../db/types.js';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface TaskRow {
  readonly id: string;
  readonly kind: string;
  readonly dedupeKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly runAt: Date;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly leaseOwner: string | null;
}

export interface DueTask {
  readonly dedupeKey: string;
  readonly runAt: Date;
  /** Delay until due by the database clock (0 when already due). */
  readonly delayMs: number;
}

interface RawTask {
  id: string;
  kind: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  run_at: Date;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  lease_owner: string | null;
}

const toTask = (r: RawTask): TaskRow => ({
  id: r.id,
  kind: r.kind,
  dedupeKey: r.dedupe_key,
  payload: r.payload,
  runAt: r.run_at,
  status: r.status,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  lastError: r.last_error,
  leaseOwner: r.lease_owner,
});

export interface ScheduleInput {
  readonly kind: string;
  /** Natural key: scheduling the same key twice is a no-op. */
  readonly dedupeKey: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Milliseconds from now (database clock). 0 = immediately. */
  readonly delayMs?: number;
  readonly maxAttempts?: number;
}

/** Durable, idempotent scheduling. Call it inside the business transaction that needs the task. */
export const scheduleTask = async (db: Db, input: ScheduleInput): Promise<{ readonly created: boolean }> => {
  const res = await db.query(
    `INSERT INTO tasks (kind, dedupe_key, payload, run_at, max_attempts)
     VALUES ($1, $2, $3::jsonb, app_now() + make_interval(secs => $4::float8 / 1000.0), $5)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [input.kind, input.dedupeKey, JSON.stringify(input.payload ?? {}), input.delayMs ?? 0, input.maxAttempts ?? 8],
  );
  return { created: res.rowCount === 1 };
};

/**
 * Takes the task for `owner` if it is due and nobody holds a live lease. Exactly one concurrent caller wins.
 * A task whose lease expired (worker killed) can be taken over; every claim counts as an attempt.
 */
export const claimTask = async (db: Db, dedupeKey: string, owner: string, leaseMs: number): Promise<TaskRow | null> => {
  const res = await db.query<RawTask>(
    `UPDATE tasks SET status = 'running', lease_owner = $2, lease_until = app_now() + make_interval(secs => $3::float8 / 1000.0),
                      attempts = attempts + 1, updated_at = app_now()
     WHERE dedupe_key = $1 AND attempts < max_attempts
       AND ((status = 'pending' AND run_at <= app_now()) OR (status = 'running' AND lease_until < app_now()))
     RETURNING *`,
    [dedupeKey, owner, leaseMs],
  );
  const row = res.rows[0];
  return row ? toTask(row) : null;
};

export const extendLease = async (db: Db, id: string, owner: string, leaseMs: number): Promise<boolean> => {
  const res = await db.query(
    `UPDATE tasks SET lease_until = app_now() + make_interval(secs => $3::float8 / 1000.0)
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [id, owner, leaseMs],
  );
  return res.rowCount === 1;
};

/** Marks done. False means the lease was lost (someone else owns the task now). */
export const completeTask = async (db: Db, id: string, owner: string): Promise<boolean> => {
  const res = await db.query(
    `UPDATE tasks SET status = 'done', completed_at = app_now(), lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = app_now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [id, owner],
  );
  return res.rowCount === 1;
};

/** Handler failed: retry after `delayMs`, or give up (status `failed`, visible to finance) when attempts are used up. */
export const failTask = async (
  db: Db,
  id: string,
  owner: string,
  error: string,
  delayMs: number,
): Promise<'retry' | 'failed' | 'lost'> => {
  const res = await db.query<{ status: TaskStatus }>(
    `UPDATE tasks SET
       status = CASE WHEN attempts >= max_attempts THEN 'failed'::task_status ELSE 'pending'::task_status END,
       run_at = CASE WHEN attempts >= max_attempts THEN run_at ELSE app_now() + make_interval(secs => $4::float8 / 1000.0) END,
       last_error = left($3, 2000), lease_owner = NULL, lease_until = NULL, updated_at = app_now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'running' RETURNING status`,
    [id, owner, error, delayMs],
  );
  const row = res.rows[0];
  if (!row) return 'lost';
  return row.status === 'failed' ? 'failed' : 'retry';
};

/** Unrecoverable (e.g. no handler for the kind): fail at once, no retries. */
export const abortTask = async (db: Db, id: string, owner: string, error: string): Promise<boolean> => {
  const res = await db.query(
    `UPDATE tasks SET status = 'failed', last_error = left($3, 2000), lease_owner = NULL, lease_until = NULL, updated_at = app_now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [id, owner, error],
  );
  return res.rowCount === 1;
};

/** Handler made progress but is not finished (e.g. one batch of a mass cancellation): run again later, attempts reset. */
export const rescheduleTask = async (db: Db, id: string, owner: string, delayMs: number): Promise<boolean> => {
  const res = await db.query(
    `UPDATE tasks SET status = 'pending', attempts = 0, run_at = app_now() + make_interval(secs => $3::float8 / 1000.0),
                      lease_owner = NULL, lease_until = NULL, updated_at = app_now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [id, owner, delayMs],
  );
  return res.rowCount === 1;
};

/** Finance restart of a failed task: attempts reset, runs now. Restarting a task that is not failed does nothing. */
export const restartTask = async (db: Db, id: string): Promise<boolean> => {
  const res = await db.query(
    `UPDATE tasks SET status = 'pending', attempts = 0, run_at = app_now(), last_error = NULL, updated_at = app_now()
     WHERE id = $1 AND status = 'failed'`,
    [id],
  );
  return res.rowCount === 1;
};

/** Running tasks whose lease expired after the last allowed attempt can never run again: mark them failed. */
export const failExhausted = async (db: Db): Promise<number> => {
  const res = await db.query(
    `UPDATE tasks SET status = 'failed', last_error = COALESCE(last_error, 'worker died on the last attempt'), lease_owner = NULL, lease_until = NULL, updated_at = app_now()
     WHERE status = 'running' AND lease_until < app_now() AND attempts >= max_attempts`,
  );
  return res.rowCount ?? 0;
};

/** Tasks that are due (or due within the horizon) and tasks abandoned by a dead worker. */
export const listDueTasks = async (db: Db, horizonMs: number, limit: number): Promise<readonly DueTask[]> => {
  const res = await db.query<{ dedupe_key: string; run_at: Date; delay_ms: number }>(
    `SELECT dedupe_key, run_at, GREATEST(0, EXTRACT(EPOCH FROM (run_at - app_now())) * 1000)::float8 AS delay_ms
     FROM tasks
     WHERE (status = 'pending' AND run_at <= app_now() + make_interval(secs => $1::float8 / 1000.0))
        OR (status = 'running' AND lease_until < app_now() AND attempts < max_attempts)
     ORDER BY run_at LIMIT $2`,
    [horizonMs, limit],
  );
  return res.rows.map((r) => ({ dedupeKey: r.dedupe_key, runAt: r.run_at, delayMs: Math.ceil(r.delay_ms) }));
};

export const getTask = async (db: Db, dedupeKey: string): Promise<TaskRow | null> => {
  const res = await db.query<RawTask>(`SELECT * FROM tasks WHERE dedupe_key = $1`, [dedupeKey]);
  const row = res.rows[0];
  return row ? toTask(row) : null;
};
