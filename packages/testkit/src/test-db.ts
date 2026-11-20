import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { TEMPLATE_DB, hostReachableUrl, withDatabase } from './db-url.js';

export interface TestDb {
  readonly pool: Pool;
  readonly url: string;
  readonly drop: () => Promise<void>;
}

/** Clones the migrated template into a private database: tests never share state. */
export const createTestDb = async (): Promise<TestDb> => {
  const adminUrl = hostReachableUrl(process.env['DATABASE_URL'] ?? '');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  await admin.end();
  const url = withDatabase(adminUrl, name);
  const pool = new Pool({ connectionString: url, max: 12 });
  // The database is force-dropped at the end of a file; a connection that was still busy then reports "terminating connection".
  // That is expected teardown noise, not a failure, so it must not surface as an unhandled error event.
  pool.on('error', () => undefined);
  pool.on('connect', (client) => void client.on('error', () => undefined));
  return {
    pool,
    url,
    drop: async () => {
      await pool.end();
      const cleaner = new Client({ connectionString: adminUrl });
      await cleaner.connect();
      await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleaner.end();
    },
  };
};
