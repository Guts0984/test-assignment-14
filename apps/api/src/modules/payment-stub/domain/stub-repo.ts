import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTxRetry } from '@ticketing/platform';
import { appError, err, ok, type Result } from '../../../common/result.js';
import { chaosModeFor, planDeliveries } from './chaos.js';

export type PaymentStatus = 'pending' | 'succeeded' | 'failed';

export interface StubPayment {
  readonly id: string;
  readonly amount: number;
  readonly orderRef: string;
  readonly returnUrl: string | null;
  readonly status: PaymentStatus;
  readonly refunded: number;
  readonly seq: number;
}

export interface StubRefund {
  readonly id: string;
  readonly paymentId: string;
  readonly amount: number;
  readonly status: 'pending' | 'succeeded' | 'failed';
}

const newId = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`;

interface PaymentRow { id: string; amount: number; order_ref: string; return_url: string | null; status: PaymentStatus; seq: number; refunded: string }

const PAYMENT_SELECT = `SELECT p.id, p.amount, p.order_ref, p.return_url, p.status, p.seq,
  COALESCE((SELECT SUM(r.amount) FROM stub_refunds r WHERE r.payment_id = p.id AND r.status <> 'failed'), 0)::text AS refunded FROM stub_payments p`;

const toPayment = (r: PaymentRow): StubPayment => ({ id: r.id, amount: r.amount, orderRef: r.order_ref, returnUrl: r.return_url, status: r.status, refunded: Number(r.refunded), seq: r.seq });

export const getPayment = async (db: Pool | PoolClient, id: string): Promise<StubPayment | null> => {
  const res = await db.query<PaymentRow>(`${PAYMENT_SELECT} WHERE p.id = $1`, [id]);
  const row = res.rows[0];
  return row ? toPayment(row) : null;
};

export interface Webhook {
  readonly eventId: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Schedules the deliveries chosen by the chaos plan (or one plain delivery when chaos is off). */
const scheduleWebhooks = async (tx: PoolClient, chaos: boolean, maxDelayMs: number, event: Webhook, stale: Webhook | null): Promise<void> => {
  const counter = chaos ? Number((await tx.query<{ n: string }>(`SELECT nextval('stub_chaos_seq')::text AS n`)).rows[0]?.n ?? 0) : 0;
  const deliveries = planDeliveries(chaos ? chaosModeFor(counter) : 'normal', maxDelayMs, Math.random());
  for (const d of deliveries) {
    const w = d.kind === 'stale_failed' ? stale : event;
    if (!w) continue;
    const payload = { id: w.eventId, type: w.type, data: w.data };
    await tx.query(
      `INSERT INTO stub_webhooks (provider_event_id, kind, payload, due_at) VALUES ($1, $2, $3::jsonb, app_now() + make_interval(secs => $4::float8 / 1000.0))`,
      [w.eventId, w.type, JSON.stringify(payload), d.delayMs],
    );
  }
};

export const createPayment = async (
  pool: Pool,
  input: { readonly amount: number; readonly orderRef: string; readonly returnUrl: string | null; readonly key: string; readonly hash: string },
): Promise<Result<{ payment: StubPayment; replayed: boolean }>> => {
  const id = newId('pay');
  const inserted = await pool.query(
    `INSERT INTO stub_payments (id, amount, order_ref, return_url, idempotency_key, request_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [id, input.amount, input.orderRef, input.returnUrl, input.key, input.hash],
  );
  if (inserted.rowCount === 1) {
    const payment = await getPayment(pool, id);
    return payment ? ok({ payment, replayed: false }) : err(appError('INTERNAL', 'payment vanished'));
  }
  const existing = (await pool.query<{ id: string; request_hash: string }>(`SELECT id, request_hash FROM stub_payments WHERE idempotency_key = $1`, [input.key])).rows[0];
  if (!existing || existing.request_hash !== input.hash) return err(appError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with different parameters'));
  const payment = await getPayment(pool, existing.id);
  return payment ? ok({ payment, replayed: true }) : err(appError('INTERNAL', 'payment vanished'));
};

/** Button clicks. The first decision wins; clicking again is a harmless no-op and sends no second webhook. */
export const settlePayment = async (
  pool: Pool,
  cfg: { readonly chaos: boolean; readonly maxDelayMs: number },
  id: string,
  outcome: 'succeeded' | 'failed',
): Promise<StubPayment | null> =>
  withTxRetry(pool, async (tx) => {
    const updated = await tx.query<{ amount: number; order_ref: string; seq: number }>(
      `UPDATE stub_payments SET status = $2::stub_payment_status, seq = seq + 1, updated_at = app_now() WHERE id = $1 AND status = 'pending' RETURNING amount, order_ref, seq`,
      [id, outcome],
    );
    const row = updated.rows[0];
    if (row) {
      const data = { paymentId: id, orderRef: row.order_ref, amount: row.amount, status: outcome, seq: row.seq };
      const event: Webhook = { eventId: newId('evt'), type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed', data };
      const stale: Webhook | null = outcome === 'succeeded' ? { eventId: newId('evt'), type: 'payment.failed', data: { ...data, status: 'failed', seq: 1 } } : null;
      await scheduleWebhooks(tx, cfg.chaos, cfg.maxDelayMs, event, stale);
    }
    return getPayment(tx, id);
  });

export const createRefund = async (
  pool: Pool,
  cfg: { readonly chaos: boolean; readonly maxDelayMs: number },
  input: { readonly paymentId: string; readonly amount: number; readonly reference: string | null; readonly key: string; readonly hash: string },
): Promise<Result<{ refund: StubRefund; replayed: boolean }>> =>
  withTxRetry(pool, async (tx) => {
    const payment = (await tx.query<{ amount: number; status: PaymentStatus; order_ref: string }>(`SELECT amount, status, order_ref FROM stub_payments WHERE id = $1 FOR UPDATE`, [input.paymentId])).rows[0];
    if (!payment) return err(appError('NOT_FOUND', 'Payment not found'));
    const existing = (await tx.query<{ id: string; request_hash: string; amount: number; status: StubRefund['status'] }>(`SELECT id, request_hash, amount, status FROM stub_refunds WHERE idempotency_key = $1`, [input.key])).rows[0];
    if (existing) {
      if (existing.request_hash !== input.hash) return err(appError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with different parameters'));
      return ok({ refund: { id: existing.id, paymentId: input.paymentId, amount: existing.amount, status: existing.status }, replayed: true });
    }
    if (payment.status !== 'succeeded') return err(appError('UNPROCESSABLE', 'Only a succeeded payment can be refunded'));
    const refunded = Number((await tx.query<{ n: string }>(`SELECT COALESCE(SUM(amount), 0)::text AS n FROM stub_refunds WHERE payment_id = $1 AND status <> 'failed'`, [input.paymentId])).rows[0]?.n ?? 0);
    if (refunded + input.amount > payment.amount) return err(appError('UNPROCESSABLE', 'Refund exceeds the remaining payment amount', { remaining: payment.amount - refunded }));
    const id = newId('ref');
    await tx.query(`INSERT INTO stub_refunds (id, payment_id, amount, status, idempotency_key, request_hash, seq, reference) VALUES ($1, $2, $3, 'succeeded', $4, $5, 1, $6)`, [id, input.paymentId, input.amount, input.key, input.hash, input.reference]);
    const data = { refundId: id, paymentId: input.paymentId, orderRef: payment.order_ref, reference: input.reference, amount: input.amount, status: 'succeeded', seq: 1 };
    await scheduleWebhooks(tx, cfg.chaos, cfg.maxDelayMs, { eventId: newId('evt'), type: 'refund.succeeded', data }, null);
    return ok({ refund: { id, paymentId: input.paymentId, amount: input.amount, status: 'succeeded' as const }, replayed: false });
  });

export const getRefund = async (db: Pool, id: string): Promise<StubRefund | null> => {
  const res = await db.query<{ id: string; payment_id: string; amount: number; status: StubRefund['status'] }>(`SELECT id, payment_id, amount, status FROM stub_refunds WHERE id = $1`, [id]);
  const row = res.rows[0];
  return row ? { id: row.id, paymentId: row.payment_id, amount: row.amount, status: row.status } : null;
};

export const getChaos = async (pool: Pool, envDefault: boolean): Promise<boolean> => {
  const res = await pool.query<{ chaos: boolean | null }>(`SELECT chaos FROM stub_config`);
  return res.rows[0]?.chaos ?? envDefault;
};

export const setChaos = async (pool: Pool, chaos: boolean | null): Promise<void> => {
  await pool.query(`UPDATE stub_config SET chaos = $1`, [chaos]);
};

export const nextRequestNumber = async (pool: Pool): Promise<number> =>
  Number((await pool.query<{ n: string }>(`SELECT nextval('stub_request_seq')::text AS n`)).rows[0]?.n ?? 0);
