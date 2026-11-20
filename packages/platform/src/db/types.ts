import type { Pool, PoolClient } from 'pg';

/** Anything that can run a query: the pool or a transaction client. */
export type Db = Pool | PoolClient;

/** Runs `fn` in a transaction on its own connection; rolls back on any error. */
export const withTx = async <T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const RETRYABLE = new Set(['40P01', '40001']);

/** Like `withTx`, but retries (with a short jittered pause) when Postgres aborts for a deadlock or serialization failure. */
export const withTxRetry = async <T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>, attempts = 4): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withTx(pool, fn);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= attempts || code === undefined || !RETRYABLE.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 25 * attempt));
    }
  }
};
