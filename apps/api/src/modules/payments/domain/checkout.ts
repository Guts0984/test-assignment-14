import type { Pool } from 'pg';
import { withTxRetry, type ProviderClient } from '@ticketing/platform';
import { appError, err, ok, type Result } from '../../../common/result.js';
import { requestHash, runIdempotent, type JsonValue } from '../../orders/domain/idempotency.js';
import { loadOrder } from '../../orders/repo/order-view.js';
import { history, lockOrder } from '@ticketing/platform';

interface Prepared {
  readonly paymentId: string;
  readonly amount: number;
  readonly [key: string]: JsonValue;
}

/**
 * Starts payment of a held order. Phase 1 (one transaction, idempotent per key): the order becomes
 * `awaiting_payment` and exactly one payment row exists for it. Phase 2: the provider payment is created with the
 * payment id as Idempotency-Key, so repeating the call (retry, double click, other api copy) yields the same payment.
 */
export const checkout = async (
  pool: Pool,
  provider: ProviderClient,
  cfg: { readonly publicUrl: string },
  input: { readonly orderId: string; readonly userId: string; readonly key: string },
) => {
  const prepared: Result<Prepared> = await runIdempotent<Prepared>(
    pool,
    { userId: input.userId, scope: `checkout:${input.orderId}`, key: input.key, hash: requestHash({ orderId: input.orderId }) },
    async (tx) => {
      const order = await lockOrder(tx, input.orderId);
      if (!order || order.user_id !== input.userId) return err(appError('NOT_FOUND', 'Order not found'));
      if (order.status === 'holding' && order.expired) {
        await tx.query(`SELECT release_order($1)`, [order.id]);
        return err(appError('HOLD_EXPIRED', 'The hold on these seats has expired'));
      }
      if (order.status !== 'holding' && order.status !== 'awaiting_payment') return err(appError('CONFLICT', `Order is ${order.status}`));
      if (order.status === 'awaiting_payment' && order.expired) return err(appError('HOLD_EXPIRED', 'The hold on these seats has expired'));
      const items = (await tx.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1`, [order.id])).rows[0]?.n ?? 0;
      if (items === 0) return err(appError('UNPROCESSABLE', 'The order has no tickets'));
      if (order.status === 'holding') {
        await tx.query(`UPDATE orders SET status = 'awaiting_payment' WHERE id = $1`, [order.id]);
        await history(tx, order.id, 'buyer', input.userId, 'checkout_started', { total: order.total });
      }
      const existing = (await tx.query<{ id: string; amount: number }>(`SELECT id, amount FROM payments WHERE order_id = $1 AND status IN ('created', 'pending') ORDER BY created_at DESC LIMIT 1`, [order.id])).rows[0];
      if (existing) return ok({ paymentId: existing.id, amount: existing.amount });
      const created = (await tx.query<{ id: string }>(`INSERT INTO payments (order_id, amount) VALUES ($1, $2) RETURNING id`, [order.id, order.total])).rows[0];
      await history(tx, order.id, 'buyer', input.userId, 'payment_created', { paymentId: created?.id });
      return ok({ paymentId: created?.id ?? '', amount: order.total });
    },
  );
  if (!prepared.ok) return prepared;

  const remote = await provider.createPayment({
    amount: prepared.value.amount,
    orderRef: input.orderId,
    returnUrl: `/orders/${input.orderId}`,
    key: prepared.value.paymentId,
  });
  if (!remote.ok) {
    if (remote.kind === 'rejected') return err(appError('UNPROCESSABLE', 'The payment provider refused the payment'));
    const retryAfterSeconds = remote.kind === 'rate_limited' ? Math.ceil(remote.retryAfterMs / 1_000) : 2;
    return err(appError('PROVIDER_UNAVAILABLE', 'The payment provider is busy, try again shortly', { retryAfterSeconds }));
  }
  await withTxRetry(pool, (tx) =>
    tx.query(`UPDATE payments SET provider_payment_id = COALESCE(provider_payment_id, $2), status = CASE WHEN status = 'created' THEN 'pending'::payment_status ELSE status END, updated_at = app_now() WHERE id = $1`, [prepared.value.paymentId, remote.value.id]),
  );
  const order = await loadOrder(pool, input.orderId, input.userId);
  if (!order) return err(appError('NOT_FOUND', 'Order not found'));
  return ok({ order, paymentId: prepared.value.paymentId, paymentUrl: remote.value.paymentUrl ?? '' });
};
