import type { Pool } from 'pg';
import { z } from 'zod';
import { withTxRetry } from '../db/types.js';
import { applyPaymentFailed, applyPaymentSucceeded } from './confirm.js';
import { applyRefundFailed, applyRefundSucceeded } from './refund-core.js';

export const providerEventSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['payment.succeeded', 'payment.failed', 'refund.succeeded', 'refund.failed']),
  data: z
    .object({
      paymentId: z.string().min(1).max(100),
      refundId: z.string().max(100).optional(),
      reference: z.string().max(100).nullable().optional(),
      orderRef: z.string().max(100).optional(),
      amount: z.number().int(),
      status: z.string(),
      seq: z.number().int().min(0),
    })
    .passthrough(),
});

export type ProviderEvent = z.infer<typeof providerEventSchema>;

export type WebhookOutcome = 'applied' | 'duplicate' | 'ignored';

/**
 * Applies a (verified) provider event exactly once. The event id is recorded in the same transaction as its effect:
 * a duplicate delivery finds it and does nothing; a crash before commit leaves no trace and the provider retries.
 * Order does not matter: a stale `failed` after `succeeded` is ignored, and `succeeded` always wins.
 */
export const processProviderEvent = async (pool: Pool, event: ProviderEvent): Promise<WebhookOutcome> =>
  withTxRetry(pool, async (tx) => {
    const fresh = await tx.query(
      `INSERT INTO payment_events (provider_event_id, kind, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (provider_event_id) DO NOTHING RETURNING provider_event_id`,
      [event.id, event.type, JSON.stringify(event)],
    );
    if (fresh.rowCount === 0) return 'duplicate';

    if (event.type.startsWith('payment.')) {
      const payment = (await tx.query<{ id: string }>(`SELECT id FROM payments WHERE provider_payment_id = $1`, [event.data.paymentId])).rows[0];
      if (!payment) return 'ignored';
      await tx.query(`UPDATE payment_events SET payment_id = $2 WHERE provider_event_id = $1`, [event.id, payment.id]);
      if (event.type === 'payment.succeeded') await applyPaymentSucceeded(tx, payment.id, event.data.seq);
      else await applyPaymentFailed(tx, payment.id, event.data.seq);
      return 'applied';
    }

    const ref = event.data.reference ?? null;
    const refund = (await tx.query<{ id: string }>(
      `SELECT id FROM refunds WHERE ($1::text IS NOT NULL AND id::text = $1) OR ($2::text IS NOT NULL AND provider_refund_id = $2) LIMIT 1`,
      [ref, event.data.refundId ?? null],
    )).rows[0];
    if (!refund) return 'ignored';
    if (event.type === 'refund.succeeded') await applyRefundSucceeded(tx, refund.id, event.data.refundId ?? null);
    else await applyRefundFailed(tx, refund.id);
    return 'applied';
  });
