import type { Pool } from 'pg';
import { cancelEventInTx, enqueue, withTxRetry } from '@ticketing/platform';
import { RULES, canTransition, EVENT_TRANSITIONS, type EventStatus } from '@ticketing/shared';
import { appError, err, ok, type Result } from '../../../common/result.js';

const ownEvent = async (tx: { query: Pool['query'] }, organizerId: string, eventId: string) =>
  (await tx.query<{ status: EventStatus; starts_at: Date; sales_start_at: Date }>(`SELECT status, starts_at, sales_start_at FROM events WHERE id = $1 AND organizer_id = $2 FOR UPDATE`, [eventId, organizerId])).rows[0];

/** Tasks that end an event's life: mark it finished at its start, pay the organizer 3 days later. Keyed by start time so a reschedule replaces them. */
export const scheduleEventTasks = async (tx: Parameters<typeof enqueue>[0], eventId: string, startsAt: Date): Promise<void> => {
  const ms = startsAt.getTime();
  const untilStart = Math.max(0, ms - Date.now());
  await enqueue(tx, 'event_finish', `event_finish:${eventId}:${ms}`, { eventId, startsAtMs: ms }, untilStart);
  await enqueue(tx, 'payout', `payout:${eventId}:${ms}`, { eventId, startsAtMs: ms }, untilStart + RULES.payoutDelayMs);
};

/** Moves the event to a new date: buyers are notified and may refund in full for 14 days. */
export const rescheduleEvent = (pool: Pool, organizerId: string, eventId: string, startsAtIso: string): Promise<Result<true>> =>
  withTxRetry(pool, async (tx) => {
    const ev = await ownEvent(tx, organizerId, eventId);
    if (!ev) return err(appError('NOT_FOUND', 'Event not found'));
    if (!canTransition(EVENT_TRANSITIONS, ev.status, 'rescheduled', 'organizer')) return err(appError('CONFLICT', `An event in status "${ev.status}" cannot be rescheduled`));
    const next = new Date(startsAtIso);
    const clock = (await tx.query<{ now: Date }>(`SELECT app_now() AS now`)).rows[0]?.now ?? new Date();
    if (next.getTime() <= clock.getTime()) return err(appError('VALIDATION_FAILED', 'The new date must be in the future', { field: 'startsAt' }));
    if (next < ev.sales_start_at) return err(appError('VALIDATION_FAILED', 'The new date is before the start of sales', { field: 'startsAt' }));
    await tx.query(`UPDATE events SET previous_starts_at = starts_at, starts_at = $2::timestamptz, rescheduled_at = app_now(), status = 'rescheduled' WHERE id = $1`, [eventId, next.toISOString()]);
    await tx.query(
      `INSERT INTO tasks (kind, dedupe_key, payload)
       SELECT 'email', 'email:resched:' || o.id || ':' || $2::text, jsonb_build_object('template', 'rescheduled', 'orderId', o.id, 'eventId', $1::uuid)
       FROM orders o WHERE o.event_id = $1 AND o.status IN ('paid', 'partially_refunded') ON CONFLICT (dedupe_key) DO NOTHING`,
      [eventId, String(next.getTime())],
    );
    await scheduleEventTasks(tx, eventId, next);
    return ok(true);
  });

export interface CancellationProgress {
  readonly status: string;
  readonly total: number;
  readonly requested: number;
  readonly pending: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly amountTotal: number;
  readonly amountRefunded: number;
}

export const cancellationProgress = async (pool: Pool, organizerId: string, eventId: string): Promise<CancellationProgress | null> => {
  const ev = (await pool.query<{ status: string }>(`SELECT status FROM events WHERE id = $1 AND organizer_id = $2`, [eventId, organizerId])).rows[0];
  if (!ev) return null;
  const r = (await pool.query<{ total: number; requested: number; pending: number; succeeded: number; failed: number; amount_total: string; amount_refunded: string }>(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE r.status = 'requested')::int AS requested, COUNT(*) FILTER (WHERE r.status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE r.status = 'succeeded')::int AS succeeded, COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed,
            COALESCE(SUM(r.amount), 0)::text AS amount_total, COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'succeeded'), 0)::text AS amount_refunded
     FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1 AND r.kind = 'event_cancelled'`,
    [eventId],
  )).rows[0];
  return { status: ev.status, total: r?.total ?? 0, requested: r?.requested ?? 0, pending: r?.pending ?? 0, succeeded: r?.succeeded ?? 0, failed: r?.failed ?? 0, amountTotal: Number(r?.amount_total ?? 0), amountRefunded: Number(r?.amount_refunded ?? 0) };
};

/** Cancels an event for its organizer: sales stop at once, every order is refunded in the background (see `cancelEventInTx`). */
export const cancelEvent = (pool: Pool, organizerId: string, eventId: string): Promise<Result<{ readonly alreadyCancelled: boolean }>> =>
  withTxRetry(pool, async (tx) => {
    const out = await cancelEventInTx(tx, eventId, organizerId);
    if (out.kind === 'not_found') return err(appError('NOT_FOUND', 'Event not found'));
    if (out.kind === 'not_allowed') return err(appError('CONFLICT', `An event in status "${out.status}" cannot be cancelled`));
    return ok({ alreadyCancelled: out.kind === 'already_cancelled' });
  });

export const assignStaff = (pool: Pool, organizerId: string, eventId: string, email: string): Promise<Result<true>> =>
  withTxRetry(pool, async (tx) => {
    const own = await tx.query(`SELECT 1 FROM events WHERE id = $1 AND organizer_id = $2`, [eventId, organizerId]);
    if (own.rowCount === 0) return err(appError('NOT_FOUND', 'Event not found'));
    const user = (await tx.query<{ id: string; role: string }>(`SELECT id, role::text AS role FROM users WHERE email = $1`, [email])).rows[0];
    if (!user || user.role !== 'scanner') return err(appError('UNPROCESSABLE', 'No scanner account with this email'));
    await tx.query(`INSERT INTO event_staff (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [eventId, user.id]);
    return ok(true);
  });

export const listStaff = async (pool: Pool, organizerId: string, eventId: string) => {
  const res = await pool.query<{ user_id: string; email: string; display_name: string }>(
    `SELECT u.id AS user_id, u.email, u.display_name FROM event_staff s JOIN users u ON u.id = s.user_id JOIN events e ON e.id = s.event_id WHERE s.event_id = $1 AND e.organizer_id = $2 ORDER BY u.email`,
    [eventId, organizerId],
  );
  return res.rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name }));
};
