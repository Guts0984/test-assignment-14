import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, waitFor, type TestDb } from '@ticketing/testkit';
import { createPgPool } from '../src/index.js';

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb.drop();
});

describe('postgres pool', () => {
  it('survives the database terminating its connections: the error is reported, not thrown, and the pool recovers', async () => {
    const errors: string[] = [];
    const url = `${tdb.url}${tdb.url.includes('?') ? '&' : '?'}application_name=pooltest`;
    const pool = createPgPool({ connectionString: url, max: 4, onError: (e) => errors.push(e.message) });
    try {
      await Promise.all(Array.from({ length: 4 }, () => pool.query('SELECT pg_sleep(0.05)'))); // four idle connections now
      const killed = await tdb.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'pooltest'`);
      expect(killed.rowCount).toBeGreaterThan(0);
      await waitFor(async () => errors.length > 0, 10_000);
      expect(errors.every((m) => /terminating connection/.test(m))).toBe(true);
      // Dead idle connections leave the pool as they report themselves; new ones are opened on demand.
      await waitFor(async () => (await pool.query('SELECT 42 AS n').catch(() => null))?.rows[0]?.n === 42, 10_000);
    } finally {
      await pool.end();
    }
  });
});
