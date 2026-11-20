import { executeRefund, type TaskHandler } from '@ticketing/platform';
import { payloadString, type HandlerDeps } from './deps.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes the next evenly spaced send slot of the shared refund budget (all worker copies together stay under the provider's limit).
 * If Redis is unavailable the budget cannot be checked: wait and ask again instead of hammering the provider.
 */
const takeBudget = async (d: HandlerDeps): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const slot = await d.limiter.reserveSlot('worker:refund-slots', d.refundRps);
    if (!slot.degraded) {
      if (slot.waitMs > 0) await sleep(slot.waitMs);
      return;
    }
    await sleep(250);
  }
  throw new Error('refund call budget unavailable');
};

/**
 * Executes one refund at the provider. Safe to repeat and to run on several workers: the provider call carries the
 * refund id as Idempotency-Key and the ledger posting is guarded by the refund row, so a 429/503, a crash or a duplicate
 * delivery can never refund twice or lose a refund.
 */
export const refundExecute = (d: HandlerDeps): TaskHandler => async (task) => {
  await takeBudget(d);
  const outcome = await executeRefund(d.pool, d.provider, payloadString(task, 'refundId'));
  if (outcome.kind === 'again') return { again: Math.max(100, outcome.afterMs) };
  return undefined;
};

/** Pushes the progress of a mass cancellation to the organizer's page until every refund has finished. */
export const massCancelNotice = (d: HandlerDeps): TaskHandler => async (task) => {
  const eventId = payloadString(task, 'eventId');
  const p = (await d.pool.query<{ total: number; requested: number; pending: number; succeeded: number; failed: number }>(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE r.status = 'requested')::int AS requested, COUNT(*) FILTER (WHERE r.status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE r.status = 'succeeded')::int AS succeeded, COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed
     FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1 AND r.kind = 'event_cancelled'`,
    [eventId],
  )).rows[0];
  if (!p) return undefined;
  d.rt.toEventAdmins(eventId, 'cancellation.progress', { eventId, ...p });
  return p.succeeded + p.failed < p.total ? { again: 1_000 } : undefined;
};
