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
