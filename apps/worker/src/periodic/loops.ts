import type { Pool } from 'pg';
import { reconcileProvider, type ProviderClient, type RealtimePublisher, type VirtualQueue } from '@ticketing/platform';

export interface Loop {
  readonly stop: () => void;
}

/** Runs `fn` every `intervalMs`, never overlapping itself; errors go to `onError` and never stop the loop. */
export const loop = (fn: () => Promise<void>, intervalMs: number, onError: (error: unknown) => void): Loop => {
  let running = false;
  let stopped = false;
  const tick = (): void => {
    if (running || stopped) return;
    running = true;
    fn()
      .catch(onError)
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); } };
};

/** Lets people into queued events (works from Postgres alone, so it also runs after Redis loses everything). */
export const admissionRound = async (pool: Pool, queue: VirtualQueue, rt: RealtimePublisher): Promise<void> => {
  const events = await pool.query<{ id: string }>(`SELECT id FROM events WHERE queue_active LIMIT 200`);
  for (const e of events.rows) {
    for (const userId of await queue.admit(e.id)) rt.toUser(userId, 'queue.update', { eventId: e.id, status: 'admitted' });
    await queue.rebuildCache(e.id).catch(() => undefined);
  }
};

/** Safety net behind the durable tasks: releases holds and offers that are over even if their task was lost. */
export const expirySweep = async (pool: Pool, rt: RealtimePublisher): Promise<void> => {
  const orders = await pool.query<{ id: string; event_id: string; user_id: string; released: boolean }>(
    `SELECT id, event_id, user_id, release_order(id) AS released FROM orders WHERE status IN ('holding', 'awaiting_payment') AND hold_expires_at <= app_now() - interval '5 seconds' ORDER BY hold_expires_at LIMIT 200`,
  );
  for (const id of new Set(orders.rows.map((r) => r.event_id))) rt.seatsChanged(id);
  // The owner's open page learns about the expiry too, not only the seat map of other viewers.
  for (const o of orders.rows) if (o.released) rt.toUser(o.user_id, 'order.updated', { orderId: o.id, status: 'expired' });
  const offers = await pool.query<{ event_id: string }>(`SELECT DISTINCT event_id FROM waitlist_offers WHERE status = 'active' AND expires_at <= app_now() LIMIT 100`);
  for (const o of offers.rows) {
    await pool.query(`SELECT waitlist_offer_next($1)`, [o.event_id]);
    rt.seatsChanged(o.event_id);
  }
};

/** The once-a-minute reconciliation with the payment provider: finds stuck payments and refunds and repairs them. */
export const reconcileRound = async (pool: Pool, provider: ProviderClient): Promise<void> => {
  await reconcileProvider(pool, provider, { olderThanMs: 120_000, limit: 100 });
};
