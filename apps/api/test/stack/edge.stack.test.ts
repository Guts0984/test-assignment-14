import { describe, expect, it } from 'vitest';
import { client, flood } from '../attacker/index.js';

/** Runs against the deployed compose stack (nginx in front of two api copies). Start it with `pnpm stack:up`. */
const base = process.env['STACK_URL'] ?? 'http://127.0.0.1:8080';
const stubKey = process.env['STUB_API_KEY'] ?? '';

describe('deployed stack: nginx + two api copies', () => {
  it('spreads requests over both api copies', async () => {
    const c = client({ baseUrl: base, sourceIp: '127.0.0.11' });
    const seen = new Set<string>();
    for (let i = 0; i < 40 && seen.size < 2; i += 1) {
      const r = await c.get('/api/health');
      expect(r.status).toBe(200);
      seen.add(String((r.json as { instance?: string }).instance));
    }
    expect([...seen].sort()).toEqual(['api-1', 'api-2']);
  });

  it('rejects an oversized body at the edge and leaks nothing', async () => {
    const c = client({ baseUrl: base, sourceIp: '127.0.0.12' });
    const r = await c.post('/api/auth/login', undefined, { rawBody: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(4 * 1024 * 1024) }) });
    expect(r.status).toBe(413);
    expect(r.text).not.toMatch(/at \w+ \(|node_modules|prisma/i);
  });

  it('sets security headers and withholds CORS from a foreign origin', async () => {
    const c = client({ baseUrl: base, sourceIp: '127.0.0.13' });
    const r = await c.get('/api/events', { headers: { origin: 'https://evil.example' }, query: { limit: 1 } });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['server']).not.toMatch(/\d/);
  });

  it('keeps the payment stub at 20 requests per second across both copies', async () => {
    expect(stubKey.length).toBeGreaterThan(0);
    const c = client({ baseUrl: base, sourceIp: '127.0.0.14' });
    // Settle: let any earlier window drain, then fire one burst far above the limit.
    const burst = await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        c.post('/stub/v1/payments', { amount: 1_000, orderRef: `edge-${i}` }, { headers: { authorization: `Bearer ${stubKey}`, 'idempotency-key': `edge-${Date.now()}-${i}` } }),
      ),
    );
    const limited = burst.filter((r) => r.status === 429);
    expect(burst.length - limited.length).toBeLessThanOrEqual(20);
    expect(limited.length).toBeGreaterThanOrEqual(60);
    expect(limited.every((r) => Number(r.headers['retry-after']) >= 0)).toBe(true);
  });

  it('keeps ordinary users responsive while one address floods', async () => {
    const attacker = client({ baseUrl: base, sourceIp: '127.0.0.15' });
    const victim = client({ baseUrl: base, sourceIp: '127.0.0.16' });
    const run = flood({ send: () => attacker.get('/api/events', { query: { limit: 5 } }), rps: 300, durationMs: 2_000 });
    const times: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const r = await victim.get('/api/events', { query: { limit: 5 } });
      expect(r.status).toBe(200);
      times.push(r.ms);
    }
    await run;
    // The budget depends on the machine: CI runs the attacker, the victims and the whole stack on two cores.
    const budgetMs = Number(process.env['STACK_P95_BUDGET_MS'] ?? 1_500);
    expect([...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95)] ?? 0).toBeLessThan(budgetMs);
  });
});
