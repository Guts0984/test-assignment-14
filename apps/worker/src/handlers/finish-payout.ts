import { RULES, payoutAmounts } from '@ticketing/shared';
import { enqueue, type TaskHandler, withTxRetry } from '@ticketing/platform';
import { payloadString, type HandlerDeps } from './deps.js';

const startsMatch = (task: { payload: Readonly<Record<string, unknown>> }, startsAt: Date): boolean => Number(task.payload['startsAtMs']) === startsAt.getTime();

/** The event date passed: sales are over. A task for an old date (the event was rescheduled meanwhile) does nothing. */
export const eventFinish = (d: HandlerDeps): TaskHandler => async (task) => {
  const eventId = payloadString(task, 'eventId');
  const ev = (await d.pool.query<{ status: string; starts_at: Date; remaining_ms: number }>(`SELECT status::text AS status, starts_at, (EXTRACT(EPOCH FROM (starts_at - app_now())) * 1000)::float8 AS remaining_ms FROM events WHERE id = $1`, [eventId])).rows[0];
  if (!ev || !startsMatch(task, ev.starts_at) || !['on_sale', 'sold_out', 'rescheduled'].includes(ev.status)) return undefined;
  if (ev.remaining_ms > 0) return { again: Math.ceil(ev.remaining_ms) + 50 };
  await d.pool.query(`UPDATE events SET status = 'finished' WHERE id = $1 AND status IN ('on_sale', 'sold_out', 'rescheduled')`, [eventId]);
  return undefined;
};

/**
 * Pays the organizer 3 days after the event: sales - refunds - 8% commission (rounded down, in the organizer's favour).
 * Waits while refunds are still in flight. One payout row per event (unique), one ledger posting per payout.
 */
export const payout = (d: HandlerDeps): TaskHandler => async (task) => {
  const eventId = payloadString(task, 'eventId');
  const ev = (await d.pool.query<{ status: string; starts_at: Date; organizer_id: string; due_ms: number }>(
    `SELECT status::text AS status, starts_at, organizer_id, (EXTRACT(EPOCH FROM (starts_at + make_interval(secs => $2::float8 / 1000.0) - app_now())) * 1000)::float8 AS due_ms FROM events WHERE id = $1`,
    [eventId, RULES.payoutDelayMs],
  )).rows[0];
  if (!ev || !startsMatch(task, ev.starts_at)) return undefined;
  if (ev.status === 'cancelled' || ev.status === 'paid_out' || ev.status === 'draft') return undefined;
  if (ev.due_ms > 0) return { again: Math.ceil(ev.due_ms) + 50 };
  const open = await d.pool.query(`SELECT 1 FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1 AND r.status IN ('requested', 'pending') LIMIT 1`, [eventId]);
  if (open.rowCount === 1) return { again: 30_000 };
  await withTxRetry(d.pool, async (tx) => {
    await tx.query(`UPDATE events SET status = 'finished' WHERE id = $1 AND status IN ('on_sale', 'sold_out', 'rescheduled')`, [eventId]);
    const totals = (await tx.query<{ sales: string; refunds: string }>(
      `SELECT COALESCE((SELECT SUM(i.price - i.discount) FROM order_items i JOIN orders o ON o.id = i.order_id JOIN payments p ON p.order_id = o.id AND p.status = 'succeeded' WHERE o.event_id = $1), 0)::text AS sales,
              COALESCE((SELECT SUM(ri.price_amount) FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1 AND r.status = 'succeeded' AND ri.active), 0)::text AS refunds`,
      [eventId],
    )).rows[0];
    const sales = Number(totals?.sales ?? 0);
    const refunds = Number(totals?.refunds ?? 0);
    const amounts = payoutAmounts(sales, refunds);
    const created = await tx.query<{ id: string }>(
      `INSERT INTO payouts (event_id, organizer_id, sales, refunds, commission, amount, status, due_at, executed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'paid', app_now(), app_now()) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
      [eventId, ev.organizer_id, sales, refunds, amounts.commission, amounts.payout],
    );
    const id = created.rows[0]?.id;
    if (!id) return;
    await tx.query(`SELECT post_payout($1)`, [id]);
    await tx.query(`UPDATE events SET status = 'paid_out' WHERE id = $1 AND status = 'finished'`, [eventId]);
    await enqueue(tx, 'email', `email:payout:${id}`, { template: 'payout', payoutId: id });
  });
  return undefined;
};
