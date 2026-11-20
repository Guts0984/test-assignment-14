import type { Pool } from 'pg';
import { retryDelayMs } from '@ticketing/shared';
import { signWebhook } from './signature.js';

export interface DispatchDeps {
  readonly pool: Pool;
  readonly url: string;
  readonly secret: string;
  /** Returns the HTTP status, or throws on network errors. */
  readonly post: (url: string, headers: Readonly<Record<string, string>>, body: string) => Promise<number>;
  readonly batch?: number;
  readonly maxAttempts?: number;
}

/**
 * Sends due webhooks. Rows are claimed with SKIP LOCKED, so any number of api copies can run this at once; a copy that
 * dies mid-send leaves the row pending and another copy sends it later (at-least-once, like real providers).
 */
export const dispatchDue = async (deps: DispatchDeps): Promise<number> => {
  const client = await deps.pool.connect();
  let sent = 0;
  try {
    await client.query('BEGIN');
    const due = await client.query<{ id: string; payload: unknown; attempts: number }>(
      `SELECT id::text, payload, attempts FROM stub_webhooks WHERE status = 'pending' AND due_at <= app_now() ORDER BY due_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [deps.batch ?? 20],
    );
    for (const row of due.rows) {
      const body = JSON.stringify(row.payload);
      const headers = { 'content-type': 'application/json', 'x-stub-signature': signWebhook(deps.secret, body, Math.floor(Date.now() / 1000)) };
      let status = 0;
      let error: string | null = null;
      try {
        status = await deps.post(deps.url, headers, body);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (status >= 200 && status < 300) {
        await client.query(`UPDATE stub_webhooks SET status = 'sent', attempts = attempts + 1, sent_at = app_now(), last_error = NULL WHERE id = $1`, [row.id]);
        sent += 1;
      } else {
        const attempts = row.attempts + 1;
        const giveUp = attempts >= (deps.maxAttempts ?? 10);
        await client.query(
          `UPDATE stub_webhooks SET attempts = $2, status = $3::stub_webhook_status, last_error = $4, due_at = app_now() + make_interval(secs => $5::float8 / 1000.0) WHERE id = $1`,
          [row.id, attempts, giveUp ? 'failed' : 'pending', error ?? `HTTP ${status}`, Math.min(retryDelayMs(attempts, Math.random()), 5_000)],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return sent;
};
