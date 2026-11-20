import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTxRetry, type RealtimePublisher, type VirtualQueue } from '@ticketing/platform';
import { PG_POOL, RT_PUBLISHER, VIRTUAL_QUEUE } from '../../infra/tokens.js';
import { appError, err, ok, type Result } from '../../common/result.js';
import { requestHash, runIdempotent, type JsonValue } from './domain/idempotency.js';
import { holdInTx, type HoldInput } from './repo/hold.js';
import { abandonOrder, applyPromo, removeItem, removePromo } from './repo/mutate.js';
import { listOrders, loadHistory, loadOrder, type OrderView } from './repo/order-view.js';

const asJson = (order: OrderView): JsonValue => order as unknown as JsonValue;

@Injectable()
export class OrdersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(VIRTUAL_QUEUE) private readonly queue: VirtualQueue,
    @Inject(RT_PUBLISHER) private readonly rt: RealtimePublisher,
  ) {}

  /** Idempotent hold. In queue mode only an admitted person may hold; the first hold starts their selection. */
  async hold(input: HoldInput, key: string): Promise<Result<OrderView>> {
    // Everyone who tries to choose seats on an open sale counts as a claimant of the event, so a crowd that skips the join
    // button still switches the queue on and is capped at the selection capacity. Not before the sale opens (those entries
    // would inflate the threshold), and not again for someone who already holds a place (keeps repeat holds off the queue lock).
    const gate = (await this.pool.query<{ open: boolean; placed: boolean }>(
      `SELECT (e.status IN ('on_sale', 'rescheduled') AND e.sales_start_at <= app_now()) AS open,
              EXISTS (SELECT 1 FROM queue_entries q WHERE q.event_id = e.id AND q.user_id = $2 AND q.status IN ('waiting', 'admitted', 'selecting')) AS placed
       FROM events e WHERE e.id = $1`,
      [input.eventId, input.userId],
    )).rows[0];
    if (gate?.open && !gate.placed) await this.queue.join(input.eventId, input.userId).catch(() => undefined);
    if (await this.queue.mustWait(input.eventId, input.userId)) {
      return err(appError('QUEUE_REQUIRED', 'Join the virtual queue and wait for your turn to choose seats'));
    }
    const result = await runIdempotent(
      this.pool,
      { userId: input.userId, scope: `hold:${input.eventId}`, key, hash: requestHash({ seatIds: [...input.seatIds].sort(), general: input.general }) },
      async (tx) => {
        const held = await holdInTx(tx, input);
        if (!held.ok) return held;
        const view = await loadOrder(tx, held.value.orderId, input.userId);
        return view ? ok(asJson(view)) : err(appError('INTERNAL', 'Order vanished'));
      },
    );
    if (result.ok) {
      await this.queue.startSelecting(input.eventId, input.userId).catch(() => undefined);
      this.rt.seatsChanged(input.eventId);
    }
    return result as Result<OrderView>;
  }

  private async mutate(orderId: string, userId: string, fn: Parameters<typeof withTxRetry<Result<true>>>[1]): Promise<Result<OrderView>> {
    const done = await withTxRetry(this.pool, async (tx) => {
      await tx.query('SAVEPOINT m');
      const r = await fn(tx);
      if (!r.ok) await tx.query('ROLLBACK TO SAVEPOINT m');
      return r;
    });
    if (!done.ok) return done;
    const view = await loadOrder(this.pool, orderId, userId);
    if (view) this.rt.seatsChanged(view.eventId);
    return view ? ok(view) : err(appError('NOT_FOUND', 'Order not found'));
  }

  removeItem = (orderId: string, itemId: string, userId: string) => this.mutate(orderId, userId, (tx) => removeItem(tx, orderId, itemId, userId));
  applyPromo = (orderId: string, userId: string, code: string) => this.mutate(orderId, userId, (tx) => applyPromo(tx, orderId, userId, code));
  removePromo = (orderId: string, userId: string) => this.mutate(orderId, userId, (tx) => removePromo(tx, orderId, userId));

  async release(orderId: string, userId: string): Promise<Result<OrderView>> {
    const done = await withTxRetry(this.pool, (tx) => abandonOrder(tx, orderId, userId));
    if (!done.ok) return done;
    const view = await loadOrder(this.pool, orderId, userId);
    if (view) this.rt.seatsChanged(view.eventId);
    return view ? ok(view) : err(appError('NOT_FOUND', 'Order not found'));
  }

  get = (orderId: string, userId: string) => loadOrder(this.pool, orderId, userId);
  list = (userId: string) => listOrders(this.pool, userId);
  history = (orderId: string, userId: string) => loadHistory(this.pool, orderId, userId);
}
