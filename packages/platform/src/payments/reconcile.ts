import type { Pool } from 'pg';
import { withTxRetry } from '../db/types.js';
import { applyPaymentFailed, applyPaymentSucceeded } from './confirm.js';
import type { ProviderClient } from './provider.js';
import { applyRefundFailed, applyRefundSucceeded } from './refund-core.js';

export interface Finding {
  readonly kind: 'payment_missed_webhook' | 'payment_failed_missed' | 'refund_missed_webhook';
  readonly ref: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ReconcileOptions {
  /** Only operations older than this are looked at (a webhook may simply be on its way). */
  readonly olderThanMs: number;
  readonly limit: number;
}

const record = async (pool: Pool, f: Finding, resolved: boolean): Promise<void> => {
  await pool.query(
    `INSERT INTO recon_findings (kind, ref, detail, resolved_at) VALUES ($1, $2, $3::jsonb, CASE WHEN $4 THEN app_now() END)
     ON CONFLICT (kind, ref) DO UPDATE SET resolved_at = COALESCE(recon_findings.resolved_at, CASE WHEN $4 THEN app_now() END)`,
    [f.kind, f.ref, JSON.stringify(f.detail), resolved],
  );
};

/**
 * Finds operations stuck between us and the provider (lost webhooks, closed windows) by asking the provider for the
 * truth, repairs them with the same code paths the webhooks use (so nothing is counted twice), and records each
 * difference as a finding. Stops quietly when the provider throttles us (it will run again in a minute).
 */
export const reconcileProvider = async (pool: Pool, provider: ProviderClient, options: ReconcileOptions): Promise<readonly Finding[]> => {
  const found: Finding[] = [];

  const payments = await pool.query<{ id: string; provider_payment_id: string; order_id: string }>(
    `SELECT id, provider_payment_id, order_id FROM payments
     WHERE status IN ('created', 'pending') AND provider_payment_id IS NOT NULL AND provider_payment_id NOT LIKE 'seed\\_%'
       AND created_at <= app_now() - make_interval(secs => $1::float8 / 1000.0)
     ORDER BY created_at LIMIT $2`,
    [options.olderThanMs, options.limit],
  );
  for (const p of payments.rows) {
    const remote = await provider.getPayment(p.provider_payment_id);
    if (!remote.ok) {
      if (remote.kind === 'rate_limited') return found;
      continue;
    }
    if (remote.value.status === 'succeeded') {
      await withTxRetry(pool, (tx) => applyPaymentSucceeded(tx, p.id, remote.value.seq ?? 2));
      const f: Finding = { kind: 'payment_missed_webhook', ref: p.id, detail: { providerPaymentId: p.provider_payment_id, orderId: p.order_id } };
      await record(pool, f, true);
      found.push(f);
    } else if (remote.value.status === 'failed') {
      await withTxRetry(pool, (tx) => applyPaymentFailed(tx, p.id, remote.value.seq ?? 1));
      const f: Finding = { kind: 'payment_failed_missed', ref: p.id, detail: { providerPaymentId: p.provider_payment_id } };
      await record(pool, f, true);
      found.push(f);
    }
  }

  const refunds = await pool.query<{ id: string; provider_refund_id: string }>(
    `SELECT id, provider_refund_id FROM refunds
     WHERE status = 'pending' AND provider_refund_id IS NOT NULL AND updated_at <= app_now() - make_interval(secs => $1::float8 / 1000.0)
     ORDER BY updated_at LIMIT $2`,
    [options.olderThanMs, options.limit],
  );
  for (const r of refunds.rows) {
    const remote = await provider.getRefund(r.provider_refund_id);
    if (!remote.ok) {
      if (remote.kind === 'rate_limited') return found;
      continue;
    }
    if (remote.value.status === 'pending') continue;
    await withTxRetry(pool, async (tx) => {
      if (remote.value.status === 'succeeded') await applyRefundSucceeded(tx, r.id, r.provider_refund_id);
      else await applyRefundFailed(tx, r.id);
    });
    const f: Finding = { kind: 'refund_missed_webhook', ref: r.id, detail: { providerRefundId: r.provider_refund_id, providerStatus: remote.value.status } };
    await record(pool, f, true);
    found.push(f);
  }
  return found;
};
