import type { Pool } from 'pg';
import { withTxRetry } from '../db/types.js';
import type { ProviderClient } from './provider.js';
import { applyRefundFailed, applyRefundSucceeded } from './refund-core.js';

export type RefundExecOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'pending' }
  /** Provider is throttling us: run again after this many ms without burning an attempt. */
  | { readonly kind: 'again'; readonly afterMs: number }
  | { readonly kind: 'rejected'; readonly message: string };

/**
 * Asks the provider to refund. Safe to repeat: the Idempotency-Key is the refund id, so a retry after 429, 503,
 * a timeout or a crash can never refund twice, and the ledger posting happens once (`applyRefundSucceeded`).
 * Provider unavailability is thrown so the task framework retries with backoff and finally shows the task as failed.
 */
export const executeRefund = async (pool: Pool, provider: ProviderClient, refundId: string): Promise<RefundExecOutcome> => {
  const row = (await pool.query<{ status: string; amount: number; provider_payment_id: string | null }>(
    `SELECT r.status, r.amount, p.provider_payment_id FROM refunds r
     JOIN payments p ON p.order_id = r.order_id AND p.status = 'succeeded' WHERE r.id = $1`,
    [refundId],
  )).rows[0];
  if (!row) throw new Error(`refund ${refundId} has no succeeded payment to refund`);
  if (row.status === 'succeeded' || row.status === 'failed') return { kind: 'done' };
  if (!row.provider_payment_id) throw new Error(`payment of refund ${refundId} has no provider id`);

  const result = await provider.createRefund({ paymentId: row.provider_payment_id, amount: row.amount, reference: refundId, key: refundId });
  if (!result.ok) {
    if (result.kind === 'rate_limited') return { kind: 'again', afterMs: result.retryAfterMs };
    if (result.kind === 'unavailable') throw new Error(`provider unavailable: ${result.message}`);
    await withTxRetry(pool, (tx) => applyRefundFailed(tx, refundId));
    return { kind: 'rejected', message: result.message };
  }
  if (result.value.status === 'succeeded') {
    await withTxRetry(pool, (tx) => applyRefundSucceeded(tx, refundId, result.value.id));
    return { kind: 'done' };
  }
  await pool.query(`UPDATE refunds SET status = 'pending', provider_refund_id = $2, updated_at = app_now() WHERE id = $1 AND status = 'requested'`, [refundId, result.value.id]);
  return { kind: 'pending' };
};
