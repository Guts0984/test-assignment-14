import { Pool } from 'pg';

/**
 * A Postgres pool that survives the database going away. Without error listeners, a restart or a failover ("terminating
 * connection due to administrator command") is an unhandled `error` event and takes the whole process down. Here the broken
 * connection is dropped, reported, and the pool simply opens new ones when the database is back.
 */
export const createPgPool = (options: { readonly connectionString: string; readonly max: number; readonly onError?: (error: Error) => void }): Pool => {
  const report = (error: Error): void => options.onError?.(error);
  const pool = new Pool({ connectionString: options.connectionString, max: options.max });
  pool.on('error', report);
  pool.on('connect', (client) => void client.on('error', report));
  return pool;
};
