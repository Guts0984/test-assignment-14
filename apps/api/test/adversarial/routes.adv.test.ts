import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ticketing/testkit';
import { client, type Client } from '../attacker/index.js';
import { bootApi, type BootedApi } from '../helpers/boot.js';
import { createUser, type TestUser } from '../helpers/session.js';

let tdb: TestDb;
let api: BootedApi;
let prod: BootedApi;
let http: Client;
let tokens: Record<'buyer' | 'organizer' | 'scanner' | 'finance', TestUser>;

interface Operation {
  readonly method: string;
  readonly path: string;
  readonly secured: boolean;
  readonly tag: string;
}

const PUBLIC = new Set([
  'GET /api/health', 'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/refresh', 'POST /api/auth/logout',
  'GET /api/events', 'GET /api/events/{id}', 'GET /api/events/{id}/layout', 'GET /api/events/{id}/seatmap',
]);

const operations = async (): Promise<readonly Operation[]> => {
  const doc = (await http.get('/docs-json')).json as { paths: Record<string, Record<string, { security?: unknown[]; tags?: string[] }>> };
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item).filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map(([method, op]) => ({ method: method.toUpperCase(), path, secured: (op.security?.length ?? 0) > 0, tag: op.tags?.[0] ?? '' })),
  );
};

const concrete = (path: string): string => path.replace(/\{[^}]+\}/g, crypto.randomUUID());

beforeAll(async () => {
  tdb = await createTestDb();
  api = await bootApi(tdb);
  prod = await bootApi(tdb, { TEST_CLOCK_ENABLED: 'false' });
  http = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.90' });
  tokens = {
    buyer: await createUser(tdb.pool, api.env, 'buyer'),
    organizer: await createUser(tdb.pool, api.env, 'organizer'),
    scanner: await createUser(tdb.pool, api.env, 'scanner'),
    finance: await createUser(tdb.pool, api.env, 'finance'),
  };
});
afterAll(async () => {
  await Promise.all([api.close(), prod.close()]);
  await tdb.drop();
});

describe('every route is protected by default', () => {
  it('the route table is not empty and only the allow-listed routes are public', async () => {
    const ops = await operations();
    expect(ops.length).toBeGreaterThan(25);
    const publicOps = ops.filter((o) => !o.secured).map((o) => `${o.method} ${o.path}`);
    expect(new Set(publicOps)).toEqual(PUBLIC);
  });

  it('each protected route answers 401 without a token, with a garbage token and with an expired-style token', async () => {
    for (const op of (await operations()).filter((o) => o.secured)) {
      for (const token of [null, 'garbage', 'a.b.c']) {
        const r = await http.request(op.method, concrete(op.path), { token, body: op.method === 'GET' || op.method === 'DELETE' ? undefined : {} });
        expect(r.status, `${op.method} ${op.path} (${token ?? 'no token'})`).toBe(401);
        expect(r.json).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      }
    }
  });

  it('role matrix: buyer-only, organizer-only and shared routes reject every other role with 403', async () => {
    const organizerTags = new Set(['venues', 'organizer', 'promos']);
    for (const op of (await operations()).filter((o) => o.secured && o.tag !== 'auth')) {
      const allowed = organizerTags.has(op.tag) ? 'organizer' : 'buyer';
      for (const role of ['buyer', 'organizer', 'scanner', 'finance'] as const) {
        if (role === allowed) continue;
        const r = await http.request(op.method, concrete(op.path), { token: tokens[role].token, body: op.method === 'GET' || op.method === 'DELETE' ? undefined : {} });
        expect(r.status, `${role} on ${op.method} ${op.path}`).toBe(403);
        expect(r.json).toMatchObject({ error: { code: 'FORBIDDEN' } });
      }
    }
  });

  it('test-only endpoints do not exist when TEST_CLOCK_ENABLED is false', async () => {
    const prodClient = client({ baseUrl: prod.baseUrl, sourceIp: '127.0.0.91' });
    const r = await prodClient.post('/api/_test/clock', { offsetMs: 3_600_000 });
    expect(r.status).toBe(404);
    expect((await prodClient.get('/api/health')).status).toBe(200);
    const clock = await tdb.pool.query(`SELECT offset_ms::text AS o FROM test_clock`);
    expect(clock.rows[0]).toMatchObject({ o: '0' });
  });

  it('the shared error format describes every documented failure in OpenAPI', async () => {
    const doc = (await http.get('/docs-json')).json as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const statuses = Object.keys(op.responses);
        expect(statuses.some((s) => s.startsWith('4') || s.startsWith('5')), `${method} ${path} documents errors`).toBe(true);
        expect(statuses, `${method} ${path} documents 500`).toContain('500');
      }
    }
  });
});
