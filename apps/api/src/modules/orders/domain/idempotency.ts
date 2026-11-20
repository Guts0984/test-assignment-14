import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HTTP_STATUS_BY_CODE, type ErrorCode } from '@ticketing/shared';
import { withTxRetry } from '@ticketing/platform';
import { appError, err, ok, type AppError, type Result } from '../../../common/result.js';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** Stable hash of what the client asked for; a reused key with a different request is refused. */
export const requestHash = (request: unknown): string => createHash('sha256').update(canonical(request)).digest('hex');

interface Stored {
  request_hash: string;
  response_status: number | null;
  response_body: { error?: AppError } & Record<string, unknown> | null;
}

/**
 * Runs `fn` at most once per (user, scope, key). The key row, the business effects and the stored response commit
 * together, so a crash can never leave a key without its effects. Parallel duplicates queue on the unique index and
 * then receive the stored answer. Business failures are stored too: a replay returns the same refusal.
 */
export const runIdempotent = async <T extends JsonValue>(
  pool: Pool,
  ctx: { readonly userId: string; readonly scope: string; readonly key: string; readonly hash: string },
  fn: (tx: PoolClient) => Promise<Result<T>>,
): Promise<Result<T>> =>
  withTxRetry(pool, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (user_id, scope, key, request_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, scope, key) DO NOTHING RETURNING id`,
      [ctx.userId, ctx.scope, ctx.key, ctx.hash],
    );
    if (inserted.rowCount === 0) {
      const stored = (await tx.query<Stored>(`SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND scope = $2 AND key = $3`, [ctx.userId, ctx.scope, ctx.key])).rows[0];
      if (!stored || stored.response_status === null || stored.response_body === null) return err(appError('CONFLICT', 'A request with this key is still being processed'));
      if (stored.request_hash !== ctx.hash) return err(appError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request'));
      if (stored.response_status >= 400 && stored.response_body.error) return err(stored.response_body.error);
      return ok(stored.response_body as unknown as T);
    }
    await tx.query('SAVEPOINT idem');
    const result = await fn(tx);
    if (result.ok) {
      await tx.query(`UPDATE idempotency_keys SET response_status = 200, response_body = $4::jsonb WHERE user_id = $1 AND scope = $2 AND key = $3`, [ctx.userId, ctx.scope, ctx.key, JSON.stringify(result.value)]);
      return result;
    }
    await tx.query('ROLLBACK TO SAVEPOINT idem');
    const status = HTTP_STATUS_BY_CODE[result.error.code as ErrorCode];
    await tx.query(`UPDATE idempotency_keys SET response_status = $4, response_body = $5::jsonb WHERE user_id = $1 AND scope = $2 AND key = $3`, [ctx.userId, ctx.scope, ctx.key, status, JSON.stringify({ error: result.error })]);
    return result;
  });
