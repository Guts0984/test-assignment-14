import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ticketing/testkit';

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb.drop();
});

const skewMs = async (): Promise<number> => {
  const r = await tdb.pool.query(`SELECT (EXTRACT(EPOCH FROM (app_now() - clock_timestamp())) * 1000)::float8 AS ms`);
  return (r.rows[0] as { ms: number }).ms;
};

describe('app_now() test clock', () => {
  it('equals the real clock by default', async () => {
    expect(Math.abs(await skewMs())).toBeLessThan(50);
  });
  it('can be advanced and rewound, and moves defaults with it', async () => {
    await tdb.pool.query(`UPDATE test_clock SET offset_ms = 11 * 60 * 1000`);
    expect(Math.abs((await skewMs()) - 660_000)).toBeLessThan(100);
    const r = await tdb.pool.query(`SELECT (app_now() + interval '10 minutes' < clock_timestamp() + interval '22 minutes') AS ok`);
    expect(r.rows[0]).toMatchObject({ ok: true });
    await tdb.pool.query(`UPDATE test_clock SET offset_ms = 0`);
    expect(Math.abs(await skewMs())).toBeLessThan(50);
  });
  it('is a single-row table', async () => {
    await expect(tdb.pool.query(`INSERT INTO test_clock (id, offset_ms) VALUES (2, 5)`)).rejects.toThrow(/check/);
  });
});
