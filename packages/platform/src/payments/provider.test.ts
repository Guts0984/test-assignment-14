import { describe, expect, it } from 'vitest';
import { createProviderClient } from './provider.js';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

const clientWith = (fetchImpl: typeof fetch) => createProviderClient({ baseUrl: 'http://provider/stub/', apiKey: 'k', fetchImpl, timeoutMs: 200 });

describe('provider client failures are values', () => {
  it('429 becomes rate_limited with the advertised delay', async () => {
    const r = await clientWith(reply(429, {}, { 'retry-after': '3' })).getPayment('pay_1');
    expect(r).toMatchObject({ ok: false, kind: 'rate_limited', retryAfterMs: 3_000 });
  });
  it('5xx and network errors become unavailable (retryable)', async () => {
    expect(await clientWith(reply(503, {})).getPayment('pay_1')).toMatchObject({ ok: false, kind: 'unavailable' });
    const boom = (async () => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    expect(await clientWith(boom).createRefund({ paymentId: 'p', amount: 1, reference: 'r', key: 'k' })).toMatchObject({ ok: false, kind: 'unavailable', message: 'ECONNRESET' });
  });
  it('a hanging provider times out instead of hanging us', async () => {
    const hang = ((_u: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timed out'))))) as unknown as typeof fetch;
    const started = Date.now();
    expect(await clientWith(hang).getPayment('pay_1')).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it('other 4xx are rejections (not retried), 2xx returns the value; the key and idempotency header are sent', async () => {
    expect(await clientWith(reply(422, { error: 'no' })).getPayment('pay_1')).toMatchObject({ ok: false, kind: 'rejected', status: 422 });
    let seen: { url: string; init?: RequestInit } | undefined;
    const spy = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: 'pay_9', status: 'pending', amount: 100, orderRef: 'o' }), { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await clientWith(spy).createPayment({ amount: 100, orderRef: 'o', returnUrl: '/x', key: 'idem-1' });
    expect(ok).toMatchObject({ ok: true, value: { id: 'pay_9' } });
    expect(seen?.url).toBe('http://provider/stub/v1/payments');
    expect(seen?.init?.headers).toMatchObject({ authorization: 'Bearer k', 'idempotency-key': 'idem-1' });
  });
});
