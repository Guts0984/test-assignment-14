import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ticketing/testkit';
import { client, type Client } from '../attacker/index.js';
import { bootApi, type BootedApi } from '../helpers/boot.js';

let tdb: TestDb;
let api: BootedApi;
let http: Client;

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootApi(tdb, { REFRESH_REPLAY_GRACE_MS: '2000' });
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.91' });
});
afterAll(async () => {
  await api.close();
  await tdb.drop();
});

type Tokens = { accessToken: string; refreshToken: string };
const register = async (): Promise<Tokens> =>
  (await http.post('/api/auth/register', { email: `rr-${crypto.randomUUID()}@example.test`, password: 'Correct-horse-battery-1', displayName: 'T' })).json as Tokens;
const refresh = (refreshToken: string) => http.post('/api/auth/refresh', { refreshToken });

describe('a refresh whose response was lost', () => {
  it('sent again at once, gets the very same successor and the session stays alive', async () => {
    const first = await register();
    const a = (await refresh(first.refreshToken)).json as Tokens;
    const again = await refresh(first.refreshToken);
    expect(again.status).toBe(200);
    const b = again.json as Tokens;
    expect(b.refreshToken).toBe(a.refreshToken);
    expect((await http.get('/api/auth/me', { token: b.accessToken })).status).toBe(200);
    expect((await refresh(b.refreshToken)).status).toBe(200); // and the successor keeps working
  });

  it('parallel presentations all get the same successor, never two live ones', async () => {
    const first = await register();
    const replies = await Promise.all(Array.from({ length: 10 }, () => refresh(first.refreshToken)));
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect(new Set(replies.map((r) => (r.json as Tokens).refreshToken)).size).toBe(1);
    const live = await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE used_at IS NOT NULL ORDER BY used_at DESC LIMIT 1) AND used_at IS NULL`);
    expect(live.rows[0]).toMatchObject({ n: 1 });
  });

  it('is still theft once the grace period is over: the whole session is revoked', async () => {
    const first = await register();
    const a = (await refresh(first.refreshToken)).json as Tokens;
    await tdb.pool.query(`UPDATE refresh_tokens SET used_at = used_at - interval '10 seconds' WHERE successor_enc IS NOT NULL`);
    const replay = await refresh(first.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.json).toMatchObject({ error: { code: 'TOKEN_REUSE_DETECTED' } });
    expect((await refresh(a.refreshToken)).status).toBe(401);
  });

  it('is still theft when the successor was already used, even inside the grace period', async () => {
    const first = await register();
    const a = (await refresh(first.refreshToken)).json as Tokens;
    const b = (await refresh(a.refreshToken)).json as Tokens; // the owner moved on with the successor
    const replay = await refresh(first.refreshToken);
    expect(replay.json).toMatchObject({ error: { code: 'TOKEN_REUSE_DETECTED' } });
    expect((await refresh(b.refreshToken)).status).toBe(401);
  });

  it('never keeps the successor in the clear', async () => {
    const first = await register();
    const a = (await refresh(first.refreshToken)).json as Tokens;
    const leaked = await tdb.pool.query(`SELECT 1 FROM refresh_tokens WHERE successor_enc LIKE '%' || $1 || '%' OR token_hash = $1`, [a.refreshToken]);
    expect(leaked.rowCount).toBe(0);
  });
});
