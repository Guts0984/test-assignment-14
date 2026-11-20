import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ticketing/testkit';
import { client, raw, type Client } from '../attacker/index.js';
import { bootApi, type BootedApi } from '../helpers/boot.js';
import { createOnSaleEvent, type ApiEvent } from '../helpers/event-fixture.js';
import { createUser, type TestUser } from '../helpers/session.js';

let tdb: TestDb;
let api: BootedApi;
let http: Client;
let organizer: TestUser;
let buyer: TestUser;
let ev: ApiEvent;

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootApi(tdb);
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.100' });
  organizer = await createUser(tdb.pool, api.env, 'organizer');
  buyer = await createUser(tdb.pool, api.env, 'buyer');
  ev = await createOnSaleEvent(http, tdb.pool, organizer, { seats: 20 });
});
afterAll(async () => {
  await api.close();
  await tdb.drop();
});

const never5xx = (status: number): void => expect(status).toBeLessThan(500);
const count = async (table: string): Promise<number> => Number(((await tdb.pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0] as { n: number }).n);

describe('injection', () => {
  const sqli = ["' OR '1'='1", "'; DROP TABLE events; --", '" OR ""="', "1; SELECT pg_sleep(5)--", "') UNION SELECT password_hash FROM users --", '%', '_', '\\', "Robert'); DROP TABLE users;--"];

  it.each(sqli)('search text %j is matched literally and never breaks the query', async (payload) => {
    const before = [await count('events'), await count('users')];
    for (const query of [{ q: payload }, { city: payload }, { category: payload }]) {
      const r = await http.get('/api/events', { query });
      never5xx(r.status);
      expect([200, 400]).toContain(r.status); // over-long values are a clean 400, everything else is a literal search
    }
    expect([await count('events'), await count('users')]).toEqual(before);
  });

  it('wildcard characters in the text are literal, not patterns', async () => {
    const r = await http.get('/api/events', { query: { q: '%' } });
    expect((r.json as { total: number }).total).toBe(0);
  });

  it.each(["price; DROP TABLE events", 'title desc, (select 1)', '1', 'e.id'])('sort=%j is refused by the whitelist', async (sort) => {
    const r = await http.get('/api/events', { query: { sort } });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('NoSQL-style operators in JSON bodies are validation errors', async () => {
    for (const body of [{ email: { $ne: null }, password: { $ne: null } }, { email: ['a@b.test'], password: 'x' }, { email: 'a@b.test', password: { $gt: '' } }]) {
      const r = await http.post('/api/auth/login', body);
      expect(r.status).toBe(400);
    }
  });

  it('hold requests with SQL, floats, negatives, strings or huge ids are validation errors', async () => {
    for (const seatIds of [["1; DROP TABLE seats"], [1.5], [-1], [0], [Number.MAX_SAFE_INTEGER + 2], [null], 'all']) {
      const r = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds }, { token: buyer.token, headers: { 'idempotency-key': `k-${crypto.randomUUID()}` } });
      expect(r.status, JSON.stringify(seatIds)).toBe(400);
    }
    expect(await count('seats')).toBe(20);
  });
});

describe('stored and reflected content', () => {
  it('XSS payloads are stored verbatim but only ever served as JSON with nosniff, never echoed in errors', async () => {
    const xss = '<img src=x onerror=alert(2)><b>';
    const venue = ((await http.post('/api/venues', { name: 'V', city: 'Kyiv', zones: [{ id: 'G', name: xss, kind: 'general', capacity: 10 }] }, { token: organizer.token })).json as { id: string; zones: { id: string }[] });
    const created = await http.post('/api/organizer/events', {
      venueId: venue.id, title: xss, description: xss, category: 'x', startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), salesStartAt: new Date().toISOString(),
      pricing: { tiers: [{ name: xss, price: 5_000 }], assignments: [{ tierIndex: 0, zoneIds: [venue.zones[0]?.id] }] },
    }, { token: organizer.token });
    expect(created.status).toBe(201);
    const id = (created.json as { id: string }).id;
    await http.post(`/api/organizer/events/${id}/publish`, {}, { token: organizer.token });
    const read = await http.get(`/api/events/${id}`);
    expect(read.headers['content-type']).toContain('application/json');
    expect(read.headers['x-content-type-options']).toBe('nosniff');
    expect((read.json as { title: string }).title).toBe(xss);
    const reflected = await http.get(`/api/events/${encodeURIComponent(xss)}`);
    expect(reflected.status).toBe(400);
    expect(reflected.text).not.toContain('<img');
    const queryEcho = await http.get('/api/events', { query: { page: xss } });
    expect(queryEcho.text).not.toContain('<img');
  });
});

describe('malformed transport and bodies', () => {
  it('NUL bytes in bodies, query strings and paths are a 400, never a 500', async () => {
    never5xx((await http.post('/api/auth/login', { email: 'a\u0000@b.test', password: 'x' })).status);
    expect((await http.post('/api/auth/login', { email: 'a@b.test', password: 'pa\u0000ss' })).status).toBe(400);
    expect((await http.get('/api/events?q=%00evil')).status).toBe(400);
    never5xx((await http.get('/api/events/%00')).status);
  });

  it('path traversal and encoded slashes find nothing', async () => {
    for (const path of ['/api/events/..%2f..%2fetc%2fpasswd', '/api/events/%2e%2e/%2e%2e/etc/passwd', '/api/../../etc/passwd', '/api/events/....//....//etc/passwd']) {
      const r = await http.get(path);
      expect([400, 404], path).toContain(r.status);
      expect(r.text).not.toContain('root:');
    }
  });

  it('wrong content types are 415, malformed or truncated JSON is 400, an empty body is 400', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/xml', 'multipart/form-data; boundary=x']) {
      const r = await http.request('POST', '/api/auth/login', { rawBody: 'email=a@b.test&password=x', headers: { 'content-type': type } });
      expect(r.status, type).toBe(415);
      expect(r.json).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    }
    for (const rawBody of ['{"email": "a@b.test", "password": ', '{{{', "{'email':'x'}", '']) {
      const r = await http.request('POST', '/api/auth/login', { rawBody });
      expect(r.status, rawBody).toBe(400);
      expect(r.json).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
  });

  it('duplicate keys do not crash and cannot smuggle extra privileges', async () => {
    const r = await http.request('POST', '/api/auth/login', { rawBody: '{"email":"a@b.test","email":"c@d.test","password":"x","password":"y"}' });
    expect(r.status).toBe(401);
  });

  it('prototype pollution payloads are refused and pollute nothing', async () => {
    for (const rawBody of ['{"__proto__":{"admin":true},"email":"a@b.test","password":"x"}', '{"constructor":{"prototype":{"admin":true}},"email":"a@b.test","password":"x"}']) {
      expect((await http.request('POST', '/api/auth/login', { rawBody })).status).toBe(400);
    }
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });

  it('oversized bodies are a 413, huge arrays and very long strings are validation errors', async () => {
    const big = await http.request('POST', '/api/auth/login', { rawBody: JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(400_000) }) });
    expect(big.status).toBe(413);
    expect(big.json).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    const arr = await http.post(`/api/events/${ev.eventId}/holds`, { seatIds: Array.from({ length: 5_000 }, (_, i) => i + 1) }, { token: buyer.token, headers: { 'idempotency-key': `k-${crypto.randomUUID()}` } });
    expect(arr.status).toBe(400);
    const long = await http.post('/api/promos', { code: 'A'.repeat(30_000), kind: 'percent', value: 5, usageLimit: 1 }, { token: organizer.token });
    expect(long.status).toBe(400);
  });

  it('deeply nested JSON is rejected without stack overflow or a 500', async () => {
    for (const rawBody of ['['.repeat(100_000), `{"a":`.repeat(20_000) + '1' + '}'.repeat(20_000)]) {
      const r = await http.request('POST', '/api/auth/login', { rawBody });
      expect(r.status).toBeGreaterThanOrEqual(400);
      never5xx(r.status);
    }
    expect((await http.get('/api/health')).status).toBe(200);
  });

  it('invalid and negative pagination is a validation error', async () => {
    for (const query of [{ page: -1 }, { page: 0 }, { page: 'abc' }, { pageSize: 0 }, { pageSize: 100_000 }, { page: 1e9 }, { pageSize: -5 }]) {
      const r = await http.get('/api/events', { query });
      expect(r.status, JSON.stringify(query)).toBe(400);
    }
  });

  it('CRLF header injection attempts do not add response headers', async () => {
    const response = await raw(api.baseUrl, `GET /api/health HTTP/1.1\r\nHost: x\r\nX-Evil: a\r\nSet-Cookie: pwned=1\r\nConnection: close\r\n\r\n`);
    expect(response.toLowerCase()).not.toContain('set-cookie: pwned');
    const encoded = await http.get('/api/events?q=a%0d%0aSet-Cookie:%20pwned=1');
    expect(encoded.headers['set-cookie']).toBeUndefined();
  });

  it('unexpected methods get a clean JSON 404 and never a stack trace', async () => {
    for (const method of ['TRACE', 'PUT', 'DELETE', 'PATCH']) {
      const r = await http.request(method, '/api/events');
      expect([404, 400, 405]).toContain(r.status);
      expect(r.headers['content-type'] ?? '').toContain('application/json');
    }
  });
});

describe('browser-facing hardening', () => {
  it('CORS: a foreign origin gets no allow-origin header; the allow-listed origin does', async () => {
    const evil = await http.get('/api/health', { headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const good = await http.get('/api/health', { headers: { origin: api.env.CORS_ORIGINS.split(',')[0] as string } });
    expect(good.headers['access-control-allow-origin']).toBe(api.env.CORS_ORIGINS.split(',')[0]);
    const preflight = await http.request('OPTIONS', '/api/auth/login', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('security headers are present and the framework is not advertised', async () => {
    const r = await http.get('/api/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeDefined();
    expect(r.headers['strict-transport-security']).toBeDefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-request-id']).toBeDefined();
  });

  it('error bodies never contain stack traces, SQL or file paths', async () => {
    const probes = [
      http.get('/api/events/not-a-uuid'),
      http.get(`/api/events/${crypto.randomUUID()}`),
      http.post('/api/auth/login', { email: 1 }),
      http.get('/api/orders', { token: 'garbage' }),
      http.request('POST', '/api/auth/login', { rawBody: '{' }),
    ];
    for (const r of await Promise.all(probes)) {
      expect(r.text).not.toMatch(/node_modules|\.ts:\d+|\bat .*\(|SELECT |INSERT |pg_|ECONN|prisma/i);
      expect((r.json as { error?: { requestId?: string } }).error?.requestId).toBeTruthy();
    }
  });
});
