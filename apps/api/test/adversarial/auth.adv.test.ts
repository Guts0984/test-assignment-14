import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, hostReachableRedisUrl, type TestDb } from '@ticketing/testkit';
import { client, flood, percentile, statusCounts, type Client } from '../attacker/index.js';
import { bootApi, type BootedApi } from '../helpers/boot.js';
import { ip, ipPrefix } from '../helpers/ips.js';
import { createUser, type TestUser } from '../helpers/session.js';

let tdb: TestDb;
let api: BootedApi;
let tight: BootedApi;
let http: Client;

const PASSWORD = 'correct-horse-battery';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootApi(tdb);
  tight = await bootApi(tdb, { REGISTER_THROTTLE_IP_MAX: '5', LOGIN_THROTTLE_IP_MAX: '30', LOGIN_THROTTLE_ACCOUNT_IP_MAX: '5', LOGIN_THROTTLE_WINDOW_SECONDS: '60' });
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.80' });
});
afterAll(async () => {
  await Promise.all([api.close(), tight.close()]);
  await tdb.drop();
});

const register = async (c: Client, email = `u-${crypto.randomUUID()}@example.test`) => {
  const r = await c.post('/api/auth/register', { email, password: PASSWORD, displayName: 'T' });
  return { email, tokens: r.json as { accessToken: string; refreshToken: string; user: { id: string } }, status: r.status };
};

describe('credentials', () => {
  it('a wrong password and an unknown account are indistinguishable (status, body, timing)', async () => {
    const { email } = await register(http);
    const wrong: number[] = [];
    const unknown: number[] = [];
    let a = { status: 0, json: undefined as unknown };
    let b = { status: 0, json: undefined as unknown };
    for (let i = 0; i < 6; i += 1) {
      const r1 = await http.post('/api/auth/login', { email, password: 'definitely-wrong-password' });
      const r2 = await http.post('/api/auth/login', { email: `nobody-${i}@example.test`, password: 'definitely-wrong-password' });
      wrong.push(r1.ms);
      unknown.push(r2.ms);
      a = r1;
      b = r2;
    }
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const strip = (j: unknown) => ({ ...(j as { error: Record<string, unknown> }).error, requestId: undefined });
    expect(strip(a.json)).toEqual(strip(b.json));
    const ratio = percentile(unknown, 50) / percentile(wrong, 50);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it('parallel registration with the same email creates exactly one account', async () => {
    const email = `race-${crypto.randomUUID()}@example.test`;
    const replies = await Promise.all(Array.from({ length: 20 }, () => http.post('/api/auth/register', { email, password: PASSWORD, displayName: 'R' })));
    expect(statusCounts(replies)).toEqual({ 201: 1, 409: 19 });
    expect((await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE email = $1`, [email])).rows[0]).toMatchObject({ n: 1 });
  });

  it('one address cannot mass-produce accounts; others can still register', async () => {
    const attacker = client({ baseUrl: tight.baseUrl, sourceIp: ip(92) });
    const innocent = client({ baseUrl: tight.baseUrl, sourceIp: ip(93) });
    const create = (c: Client) => c.post('/api/auth/register', { email: `bulk-${crypto.randomUUID()}@example.test`, password: PASSWORD, displayName: 'B' });
    const replies = await Promise.all(Array.from({ length: 40 }, () => create(attacker)));
    expect(statusCounts(replies)).toEqual({ 201: 5, 429: 35 });
    expect(Number(replies.find((r) => r.status === 429)?.headers['retry-after'])).toBeGreaterThan(0);
    expect((await create(innocent)).status).toBe(201);
  });

  it('mass assignment: role, id and unknown fields are refused', async () => {
    for (const extra of [{ role: 'finance' }, { id: crypto.randomUUID() }, { isAdmin: true }]) {
      const r = await http.request('POST', '/api/auth/register', { rawBody: JSON.stringify({ email: `x-${crypto.randomUUID()}@example.test`, password: PASSWORD, displayName: 'X', ...extra }) });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    const sneaky = await http.request('POST', '/api/auth/register', { rawBody: `{"email":"p-${crypto.randomUUID()}@example.test","password":"${PASSWORD}","displayName":"X","__proto__":{"role":"finance"}}` });
    expect(sneaky.status).toBe(400);
    expect(({} as Record<string, unknown>)['role']).toBeUndefined();
  });

  it('weak or oversized input is a validation error', async () => {
    expect((await http.post('/api/auth/register', { email: 'not-an-email', password: PASSWORD, displayName: 'X' })).status).toBe(400);
    expect((await http.post('/api/auth/register', { email: 'a@b.test', password: 'short', displayName: 'X' })).status).toBe(400);
    expect((await http.post('/api/auth/login', { email: 'a@b.test', password: 'x'.repeat(5_000) })).status).toBe(400);
  });
});

describe('access tokens', () => {
  let victim: TestUser;
  const secret = (): Uint8Array => new TextEncoder().encode(api.env.JWT_ACCESS_SECRET);
  const sign = (claims: Record<string, unknown>, opts: { secret?: Uint8Array; exp?: string | number; nbf?: number; sub?: string | null } = {}) => {
    let jwt = new SignJWT({ typ: 'access', ...claims }).setProtectedHeader({ alg: 'HS256' }).setIssuer('ticketing').setAudience('ticketing-api').setIssuedAt();
    if (opts.sub !== null) jwt = jwt.setSubject(opts.sub ?? victim.id);
    if (opts.nbf !== undefined) jwt = jwt.setNotBefore(opts.nbf);
    return jwt.setExpirationTime(opts.exp ?? '10m').sign(opts.secret ?? secret());
  };
  const me = (token: string) => http.get('/api/auth/me', { token });

  beforeAll(async () => {
    victim = await createUser(tdb.pool, api.env);
  });

  it('accepts a good token (control)', async () => {
    expect((await me(victim.token)).status).toBe(200);
  });

  it.each([
    ['no token', async () => ''],
    ['garbage', async () => 'not.a.jwt'],
    ['alg none', async () => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: victim.id, role: 'finance', sid: victim.familyId, typ: 'access', iss: 'ticketing', aud: 'ticketing-api', exp: Math.floor(Date.now() / 1000) + 600 })}.`],
    ['wrong secret', async () => sign({ role: 'buyer', sid: victim.familyId }, { secret: new TextEncoder().encode('x'.repeat(40)) })],
    ['expired', async () => sign({ role: 'buyer', sid: victim.familyId }, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['not yet valid', async () => sign({ role: 'buyer', sid: victim.familyId }, { nbf: Math.floor(Date.now() / 1000) + 3_600 })],
    ['missing sid claim', async () => sign({ role: 'buyer' })],
    ['missing subject', async () => sign({ role: 'buyer', sid: victim.familyId }, { sub: null })],
    ['unknown role claim', async () => sign({ role: 'root', sid: victim.familyId })],
    ['session that never existed', async () => sign({ role: 'buyer', sid: crypto.randomUUID() })],
    ['refresh-type token used as access', async () => sign({ role: 'buyer', sid: victim.familyId, typ: 'refresh' })],
  ])('rejects %s with 401', async (_name, make) => {
    const token = await make();
    const r = await me(token);
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('a payload edited after signing (role escalation) fails the signature check', async () => {
    const [h, , s] = victim.token.split('.');
    const forged = `${h}.${b64({ sub: victim.id, role: 'finance', sid: victim.familyId, typ: 'access', iss: 'ticketing', aud: 'ticketing-api', exp: Math.floor(Date.now() / 1000) + 600 })}.${s}`;
    expect((await me(forged)).status).toBe(401);
  });

  it('a token cannot be replayed after logout', async () => {
    const { tokens } = await register(http);
    expect((await me(tokens.accessToken)).status).toBe(200);
    expect((await http.post('/api/auth/logout', { refreshToken: tokens.refreshToken })).status).toBe(204);
    expect((await me(tokens.accessToken)).status).toBe(401);
    expect((await http.post('/api/auth/refresh', { refreshToken: tokens.refreshToken })).status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('rotate on every use; replaying an old one revokes the whole family', async () => {
    const { tokens } = await register(http);
    const rotated = await http.post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
    expect(rotated.status).toBe(200);
    const next = rotated.json as { accessToken: string; refreshToken: string };
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    const replay = await http.post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.json).toMatchObject({ error: { code: 'TOKEN_REUSE_DETECTED' } });
    expect((await http.post('/api/auth/refresh', { refreshToken: next.refreshToken })).status).toBe(401); // the thief and the owner are both out
    expect((await http.get('/api/auth/me', { token: next.accessToken })).status).toBe(401);
  });

  it('10 parallel refreshes with one token: exactly one wins', async () => {
    const { tokens } = await register(http);
    const replies = await Promise.all(Array.from({ length: 10 }, () => http.post('/api/auth/refresh', { refreshToken: tokens.refreshToken })));
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 401)).toHaveLength(9);
  });

  it('garbage refresh tokens are refused without leaking anything', async () => {
    for (const refreshToken of ['x'.repeat(30), 'A'.repeat(43), '../../etc/passwd'.padEnd(30, 'x')]) {
      const r = await http.post('/api/auth/refresh', { refreshToken });
      expect(r.status).toBe(401);
    }
  });
});

describe('login throttling', () => {
  const login = (c: Client, email: string, password = 'wrong-password-123') => c.post('/api/auth/login', { email, password });
  const t = (ip: string) => client({ baseUrl: tight.baseUrl, sourceIp: ip });

  it('an attacker IP is limited after the limit with Retry-After while innocent IPs keep logging in fast', async () => {
    const owner = await register(http);
    const attacker = t(ip(81));
    const innocent = [t(ip(82)), t(ip(83))];
    const attackReplies = flood({ send: () => login(attacker, `victim-${crypto.randomUUID()}@example.test`), rps: 200, durationMs: 800 });
    const goodLogins = flood({ send: () => login(innocent[Math.floor(Math.random() * 2)] as Client, owner.email, PASSWORD), rps: 4, durationMs: 800 });
    const [bad, good] = await Promise.all([attackReplies, goodLogins]);
    const counts = statusCounts(bad);
    expect(counts[401]).toBe(30); // exactly the limit, even under 200 requests per second
    expect(counts[429]).toBe(bad.length - 30);
    const limited = bad.find((r) => r.status === 429);
    expect(Number(limited?.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited?.json).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(good.every((r) => r.status === 200)).toBe(true);
    expect(percentile(good.map((r) => r.ms), 95)).toBeLessThan(4_000); // budget with the whole suite running in parallel on one machine
  });

  it('spoofed X-Forwarded-For / X-Real-IP / Forwarded headers neither evade the limit nor frame another address', async () => {
    const attacker = t(ip(84));
    const victimIp = ip(85);
    const replies = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        login(attacker, `spoof-${i}@example.test`).then((r) => r),
      ).map((p, i) => p.then((r) => ({ r, i }))),
    );
    expect(statusCounts(replies.map((x) => x.r))[401]).toBe(30);
    const rotating = await Promise.all(
      Array.from({ length: 20 }, (_, i) => attacker.post('/api/auth/login', { email: `rot-${i}@example.test`, password: 'wrong-password-123' }, { headers: { 'x-forwarded-for': `10.0.${i}.1`, 'x-real-ip': `10.1.${i}.1`, forwarded: `for=10.2.${i}.1` } })),
    );
    expect(rotating.every((r) => r.status === 429)).toBe(true); // rotating fake origins do not reset the counter
    const framed = await Promise.all(Array.from({ length: 5 }, () => attacker.post('/api/auth/login', { email: 'a@example.test', password: 'wrong-password-123' }, { headers: { 'x-forwarded-for': victimIp } })));
    expect(framed.every((r) => r.status === 429)).toBe(true);
    const owner = await register(http);
    const victim = t(victimIp);
    expect((await login(victim, owner.email, PASSWORD)).status).toBe(200); // the framed address is untouched
  });

  it('per account+IP: an attacker locks out only their own address, never the real owner', async () => {
    const owner = await register(http);
    const attacker = t(ip(86));
    const results = [];
    for (let i = 0; i < 7; i += 1) results.push((await login(attacker, owner.email, 'wrong-password-123')).status);
    expect(results).toEqual([401, 401, 401, 401, 401, 429, 429]); // exactly 5 attempts per account and IP
    expect((await login(attacker, owner.email, PASSWORD)).status).toBe(429); // even the right password is held back for the attacker's IP
    expect((await login(t(ip(87)), owner.email, PASSWORD)).status).toBe(200); // the owner from elsewhere gets in
  });

  it('many distinct source addresses leave only keys that expire', async () => {
    const redis = (await import('@ticketing/platform')).createRedis(hostReachableRedisUrl(process.env['REDIS_URL'] ?? 'redis://localhost:6379'));
    for (let i = 0; i < 40; i += 1) await login(t(ip(100 + i)), `grow-${i}@example.test`);
    const keys = await redis.keys(`login:ip:${ipPrefix}.1*`);
    expect(keys.length).toBe(40);
    for (const k of keys) expect(await redis.pttl(k)).toBeGreaterThan(0);
    redis.disconnect();
  });

  it('with Redis unavailable login still works (documented fail-open) and does not hang', async () => {
    const dead = await bootApi(tdb, { REDIS_URL: 'redis://127.0.0.1:6399', LOGIN_THROTTLE_IP_MAX: '1', LOGIN_THROTTLE_ACCOUNT_IP_MAX: '1' });
    try {
      const user = await register(http);
      const c = client({ baseUrl: dead.baseUrl, sourceIp: ip(88) });
      const started = Date.now();
      const replies = await Promise.all(Array.from({ length: 3 }, () => c.post('/api/auth/login', { email: user.email, password: PASSWORD })));
      expect(replies.every((r) => r.status === 200)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await dead.close();
    }
  });
});
