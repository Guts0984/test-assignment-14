import { randomUUID } from 'node:crypto';

export const BASE = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:8080';
export const API_1 = process.env['E2E_API_1_URL'] ?? 'http://127.0.0.1:8081';
export const API_2 = process.env['E2E_API_2_URL'] ?? 'http://127.0.0.1:8082';
export const SEED_PASSWORD = process.env['SEED_USER_PASSWORD'] ?? '';

export interface Session {
  readonly token: string;
  readonly email: string;
}

const call = async <T>(method: string, path: string, body?: unknown, token?: string, base = BASE): Promise<{ status: number; json: T }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
};

export const post = <T>(path: string, body: unknown, token?: string) => call<T>('POST', path, body, token);
export const get = <T>(path: string, token?: string) => call<T>('GET', path, undefined, token);

export const login = async (email: string, password = SEED_PASSWORD): Promise<Session> => {
  const r = await post<{ accessToken: string }>('/api/auth/login', { email, password });
  if (r.status !== 200 && r.status !== 201) throw new Error(`login ${email}: ${r.status}`);
  return { token: r.json.accessToken, email };
};

/** A fresh buyer per test, so parallel tests never share a hold limit, order or queue position. */
export const registerBuyer = async (): Promise<{ email: string; password: string }> => {
  const email = `e2e-${randomUUID().slice(0, 12)}@example.test`;
  const password = 'E2e-Passw0rd-long';
  const r = await post('/api/auth/register', { email, password, displayName: 'E2E Buyer' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register: ${r.status}`);
  return { email, password };
};

export interface EventSpec {
  readonly seats: number;
  readonly perPersonLimit?: number;
}

/** Hall + on-sale event, created the way an organizer would, through the public API. */
export const createEvent = async (spec: EventSpec): Promise<{ eventId: string; title: string; organizerToken: string }> => {
  const org = await login(`organizer${1 + Math.floor(Math.random() * 20)}@example.test`);
  const rows = Math.ceil(spec.seats / 10);
  const venue = await post<{ id: string; zones: { id: string; key: string }[] }>(
    '/api/venues',
    {
      name: `E2E hall ${randomUUID().slice(0, 6)}`,
      city: 'Kyiv',
      zones: [{ id: 'A', name: 'Stalls', kind: 'seated', rows: Array.from({ length: rows }, (_, r) => ({ label: String(r + 1), seats: Array.from({ length: Math.min(10, spec.seats - r * 10) }, (_, n) => ({ number: n + 1, x: n * 10, y: r * 10 })) })) }],
    },
    org.token,
  );
  if (venue.status !== 201) throw new Error(`venue: ${venue.status} ${JSON.stringify(venue.json)}`);
  const zone = venue.json.zones.find((z) => z.key === 'A');
  const title = `E2E Concert ${randomUUID().slice(0, 8)}`;
  const created = await post<{ id: string }>(
    '/api/organizer/events',
    {
      venueId: venue.json.id,
      title,
      category: 'rock',
      startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      salesStartAt: new Date(Date.now() - 86_400_000).toISOString(),
      ...(spec.perPersonLimit ? { perPersonLimit: spec.perPersonLimit } : {}),
      pricing: { tiers: [{ name: 'Standard', price: 100_000 }], assignments: [{ tierIndex: 0, zoneIds: [zone?.id ?? ''] }] },
    },
    org.token,
  );
  if (created.status !== 201) throw new Error(`event: ${created.status} ${JSON.stringify(created.json)}`);
  const pub = await post(`/api/organizer/events/${created.json.id}/publish`, {}, org.token);
  if (pub.status !== 200) throw new Error(`publish: ${pub.status}`);
  return { eventId: created.json.id, title, organizerToken: org.token };
};

export const setClockOffset = async (offsetMs: number): Promise<void> => {
  await post('/api/_test/clock', { offsetMs });
};
