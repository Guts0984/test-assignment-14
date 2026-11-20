import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, createTestRedis, waitFor, type TestDb } from '@ticketing/testkit';
import { verifyWebhook } from '../../src/modules/payment-stub/domain/signature.js';
import { client, statusCounts, type Client, type Reply } from '../attacker/index.js';
import { bootApi, type BootedApi } from '../helpers/boot.js';
import { startWebhookSink } from '../helpers/webhook-sink.js';

let tdb: TestDb;
let sink: Awaited<ReturnType<typeof startWebhookSink>>;
let a: BootedApi;
let b: BootedApi;
let ca: Client;
let cb: Client;

const auth = (): Record<string, string> => ({ authorization: `Bearer ${a.env.STUB_API_KEY}` });
const idemKey = (): string => `k-${crypto.randomUUID()}`;

beforeAll(async () => {
  tdb = await createTestDb();
  sink = await startWebhookSink();
  const env = { PAYMENT_WEBHOOK_URL: sink.url, STUB_DISPATCH_INTERVAL_MS: '100', STUB_CHAOS_MAX_DELAY_MS: '1500' };
  a = await bootApi(tdb, env);
  b = await bootApi(tdb, { ...env, API_INSTANCE_ID: 'api-2' });
  ca = client({ baseUrl: a.baseUrl, sourceIp: '127.0.0.120' });
  cb = client({ baseUrl: b.baseUrl, sourceIp: '127.0.0.121' });
  await tdb.pool.query(`UPDATE stub_config SET chaos = false`);
});
afterAll(async () => {
  await Promise.all([a.close(), b.close()]);
  await sink.close();
  await tdb.drop();
});

const spaced = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 70)); // stay far below 20 rps

const createPayment = async (c: Client, amount = 50_000, orderRef = `order-${crypto.randomUUID()}`, key = idemKey()) => {
  const r = await c.post('/stub/v1/payments', { amount, orderRef }, { headers: { ...auth(), 'idempotency-key': key } });
  await spaced();
  return { reply: r, key, orderRef, payment: r.json as { id: string; status: string; paymentUrl: string } };
};
const click = async (c: Client, id: string, action: 'success' | 'failure' | 'close'): Promise<Reply> => {
  const r = await c.post(`/stub/pay/${id}/${action}`, undefined);
  await spaced();
  return r;
};
const hooksFor = (orderRef: string) => sink.received.filter((h) => h.json.data['orderRef'] === orderRef);

describe('provider API', () => {
  it('needs the shop API key', async () => {
    for (const headers of [{} as Record<string, string>, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${a.env.STUB_API_KEY}x` }]) {
      const r = await ca.post('/stub/v1/payments', { amount: 1_000, orderRef: 'x' }, { headers: { ...headers, 'idempotency-key': idemKey() } });
      expect(r.status).toBe(401);
      await spaced();
    }
  });

  it('create is idempotent per key; the same key with other parameters is refused; the key is required', async () => {
    const first = await createPayment(ca, 12_300, 'order-idem');
    const again = await ca.post('/stub/v1/payments', { amount: 12_300, orderRef: 'order-idem' }, { headers: { ...auth(), 'idempotency-key': first.key } });
    await spaced();
    expect((again.json as { id: string }).id).toBe(first.payment.id);
    const other = await ca.post('/stub/v1/payments', { amount: 99_999, orderRef: 'order-idem' }, { headers: { ...auth(), 'idempotency-key': first.key } });
    await spaced();
    expect(other.status).toBe(422);
    const none = await ca.post('/stub/v1/payments', { amount: 1_000, orderRef: 'x' }, { headers: auth() });
    await spaced();
    expect(none.status).toBe(400);
  });

  it('validates input strictly and never redirects to foreign sites', async () => {
    const send = async (body: unknown) => {
      const r = await ca.post('/stub/v1/payments', body, { headers: { ...auth(), 'idempotency-key': idemKey() } });
      await spaced();
      return r.status;
    };
    expect(await send({ amount: 5.5, orderRef: 'x' })).toBe(400);
    expect(await send({ amount: -5, orderRef: 'x' })).toBe(400);
    expect(await send({ amount: 1_000, orderRef: 'x', extra: 1 })).toBe(400);
    expect(await send({ amount: 1_000, orderRef: 'x', returnUrl: 'https://evil.example/steal' })).toBe(400);
    expect(await send({ amount: 1_000, orderRef: 'x', returnUrl: '//evil.example' })).toBe(400);
    expect(await send({ amount: 1_000, orderRef: 'x', returnUrl: '/orders/1' })).toBe(200);
  });

  it('serves a payment page with the three buttons and escapes hostile references', async () => {
    const { payment } = await createPayment(ca, 20_000, '<script>alert(1)</script>');
    const page = await ca.get(`/stub/pay/${payment.id}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.text).toContain('Success');
    expect(page.text).toContain('Failure');
    expect(page.text).toContain('Close without answer');
    expect(page.text).not.toContain('<script>alert(1)</script>');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('webhooks', () => {
  it('Success sends exactly one signed webhook; Failure sends a failed one; Close sends nothing', async () => {
    const ok = await createPayment(ca, 30_000);
    const bad = await createPayment(ca, 40_000);
    const closed = await createPayment(ca, 50_000);
    await click(ca, ok.payment.id, 'success');
    await click(ca, bad.payment.id, 'failure');
    await click(ca, closed.payment.id, 'close');
    await waitFor(() => hooksFor(ok.orderRef).length >= 1 && hooksFor(bad.orderRef).length >= 1);
    const hook = hooksFor(ok.orderRef)[0];
    expect(hook?.json).toMatchObject({ type: 'payment.succeeded', data: { paymentId: ok.payment.id, amount: 30_000, status: 'succeeded' } });
    expect(verifyWebhook(a.env.STUB_WEBHOOK_SECRET, String(hook?.headers['x-stub-signature']), hook?.body ?? '', Math.floor(Date.now() / 1000))).toBe('ok');
    expect(hooksFor(bad.orderRef)[0]?.json).toMatchObject({ type: 'payment.failed' });
    expect(hooksFor(closed.orderRef)).toHaveLength(0);
    const status = await ca.get(`/stub/v1/payments/${closed.payment.id}`, { headers: auth() });
    expect(status.json).toMatchObject({ status: 'pending' }); // the shop learns nothing from a closed window, reconciliation must ask
  });

  it('clicking again (or clicking the other button) after the decision changes nothing and sends nothing more', async () => {
    const p = await createPayment(ca, 31_000);
    await click(ca, p.payment.id, 'success');
    await click(cb, p.payment.id, 'success');
    await click(ca, p.payment.id, 'failure');
    await waitFor(() => hooksFor(p.orderRef).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(hooksFor(p.orderRef)).toHaveLength(1);
    expect((await ca.get(`/stub/v1/payments/${p.payment.id}`, { headers: auth() })).json).toMatchObject({ status: 'succeeded' });
  });

  it('a failing receiver is retried until it answers 2xx, and nothing is lost', async () => {
    const p = await createPayment(ca, 32_000);
    sink.failNext(3);
    await click(ca, p.payment.id, 'success');
    await waitFor(() => hooksFor(p.orderRef).length >= 1, 20_000);
    expect(hooksFor(p.orderRef)).toHaveLength(1);
  });

  it('two api copies dispatching at once deliver each webhook once', async () => {
    const payments: Awaited<ReturnType<typeof createPayment>>[] = [];
    for (let i = 0; i < 12; i += 1) payments.push(await createPayment(i % 2 === 0 ? ca : cb, 10_000 + i));
    for (const [i, p] of payments.entries()) await click(i % 2 === 0 ? cb : ca, p.payment.id, 'success');
    await waitFor(() => payments.every((p) => hooksFor(p.orderRef).length >= 1), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const p of payments) expect(hooksFor(p.orderRef)).toHaveLength(1);
  });
});

describe('refunds', () => {
  it('accepts partial and full refunds, never more than was paid, idempotently, with webhooks', async () => {
    const p = await createPayment(ca, 100_000);
    await click(ca, p.payment.id, 'success');
    const refund = async (amount: number, key = idemKey()) => {
      const r = await ca.post('/stub/v1/refunds', { paymentId: p.payment.id, amount }, { headers: { ...auth(), 'idempotency-key': key } });
      await spaced();
      return r;
    };
    const first = await refund(30_000);
    expect(first.json).toMatchObject({ status: 'succeeded', amount: 30_000 });
    const key = idemKey();
    const second = await refund(50_000, key);
    const replay = await refund(50_000, key);
    expect((replay.json as { id: string }).id).toBe((second.json as { id: string }).id);
    expect((await refund(20_001)).status).toBe(422); // only 20 000 are left
    expect((await refund(20_000)).status).toBe(200);
    expect((await refund(1)).status).toBe(422);
    expect((await ca.get(`/stub/v1/payments/${p.payment.id}`, { headers: auth() })).json).toMatchObject({ refunded: 100_000 });
    await waitFor(() => hooksFor(p.orderRef).filter((h) => h.json.type === 'refund.succeeded').length >= 3);
    expect(hooksFor(p.orderRef).filter((h) => h.json.type === 'refund.succeeded')).toHaveLength(3);
    expect((await ca.get(`/stub/v1/refunds/${(first.json as { id: string }).id}`, { headers: auth() })).json).toMatchObject({ status: 'succeeded' });
  });

  it('refuses refunds of unpaid, failed or unknown payments and 20 parallel refunds cannot exceed the payment', async () => {
    const pending = await createPayment(ca, 10_000);
    const r1 = await ca.post('/stub/v1/refunds', { paymentId: pending.payment.id, amount: 100 }, { headers: { ...auth(), 'idempotency-key': idemKey() } });
    await spaced();
    expect(r1.status).toBe(422);
    const r2 = await ca.post('/stub/v1/refunds', { paymentId: `pay_${'0'.repeat(24)}`, amount: 100 }, { headers: { ...auth(), 'idempotency-key': idemKey() } });
    await spaced();
    expect(r2.status).toBe(404);
    const paid = await createPayment(ca, 10_000);
    await click(ca, paid.payment.id, 'success');
    const replies = [];
    for (let batch = 0; batch < 4; batch += 1) {
      replies.push(...(await Promise.all(Array.from({ length: 5 }, (_, i) => (i % 2 ? ca : cb).post('/stub/v1/refunds', { paymentId: paid.payment.id, amount: 1_000 }, { headers: { ...auth(), 'idempotency-key': idemKey() } })))));
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    expect(replies.filter((r) => r.status === 200)).toHaveLength(10);
    expect((await ca.get(`/stub/v1/payments/${paid.payment.id}`, { headers: auth() })).json).toMatchObject({ refunded: 10_000 });
  });
});

describe('20 requests per second', () => {
  it('a burst gets 429 with Retry-After beyond 20 in a second, and recovers', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const replies = await Promise.all(Array.from({ length: 60 }, () => ca.get('/stub/v1/payments/pay_000000000000000000000000', { headers: auth() })));
    const counts = statusCounts(replies);
    expect(counts[404]).toBe(20); // admitted (the payment does not exist, that is fine)
    expect(counts[429]).toBe(40);
    expect(Number(replies.find((r) => r.status === 429)?.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(replies.find((r) => r.status === 429)?.json).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    await waitFor(async () => (await ca.get('/stub/v1/payments/pay_000000000000000000000000', { headers: auth() })).status === 404, 3_000);
  });

  it('the limit is shared by both api copies: in any one-second window at most 20 requests get through', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const stamps: number[] = [];
    const fire = async (c: Client): Promise<void> => {
      const r = await c.get('/stub/v1/payments/pay_000000000000000000000000', { headers: auth() });
      if (r.status !== 429) stamps.push(Date.now());
    };
    const end = Date.now() + 2_500;
    while (Date.now() < end) {
      await Promise.all(Array.from({ length: 12 }, (_, i) => fire(i % 2 ? ca : cb)));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    stamps.sort((x, y) => x - y);
    expect(stamps.length).toBeGreaterThan(30);
    for (let i = 0; i + 20 < stamps.length; i += 1) {
      expect((stamps[i + 20] ?? 0) - (stamps[i] ?? 0), '21 admitted requests inside one second').toBeGreaterThanOrEqual(1_000);
    }
  });

  it('losing all Redis data only resets the counter; the stub keeps working', async () => {
    const tr = createTestRedis();
    await tr.redis.flushall();
    await tr.close();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await ca.get('/stub/v1/payments/pay_000000000000000000000000', { headers: auth() })).status).toBe(404);
  });

  it('without Redis the stub fails closed with 503 instead of letting the limit slip', async () => {
    const dead = await bootApi(tdb, { REDIS_URL: 'redis://127.0.0.1:6399' });
    try {
      const c = client({ baseUrl: dead.baseUrl, sourceIp: '127.0.0.122' });
      const started = Date.now();
      const r = await c.get('/stub/v1/payments/pay_000000000000000000000000', { headers: { authorization: `Bearer ${dead.env.STUB_API_KEY}` } });
      expect(r.status).toBe(503);
      expect(r.json).toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await dead.close();
    }
  });
});

describe('chaos mode', () => {
  beforeAll(async () => {
    await ca.post('/api/_test/stub-chaos', { chaos: true });
  });
  afterAll(async () => {
    await ca.post('/api/_test/stub-chaos', { chaos: false });
  });

  it('every tenth request answers 503', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const codes: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      codes.push((await ca.get('/stub/v1/payments/pay_000000000000000000000000', { headers: auth() })).status);
      await spaced();
    }
    const unavailable = codes.filter((c) => c === 503).length;
    expect(unavailable).toBeGreaterThanOrEqual(2);
    expect(unavailable).toBeLessThanOrEqual(4);
    expect(codes.filter((c) => c !== 503 && c !== 404 && c !== 429)).toEqual([]);
  });

  it('webhooks are duplicated, delayed, reordered (failed after succeeded) or lost - in a regular cycle', async () => {
    const calls = async (): Promise<number> => {
      const row = (await tdb.pool.query(`SELECT last_value::text AS v, is_called FROM stub_chaos_seq`)).rows[0] as { v: string; is_called: boolean };
      return row.is_called ? Number(row.v) : 0;
    };
    const before = await calls();
    const made: { orderRef: string; paymentId: string }[] = [];
    for (let i = 0; i < 10; i += 1) {
      let created: Awaited<ReturnType<typeof createPayment>> | undefined;
      for (let attempt = 0; attempt < 5 && created?.reply.status !== 200; attempt += 1) created = await createPayment(ca, 70_000 + i);
      let settled = 0;
      for (let attempt = 0; attempt < 5 && settled !== 200 && settled !== 303; attempt += 1) settled = (await click(ca, created?.payment.id ?? '', 'success')).status;
      made.push({ orderRef: created?.orderRef ?? '', paymentId: created?.payment.id ?? '' });
    }
    expect((await calls()) - before).toBe(10);
    await waitFor(() => sink.received.filter((h) => made.some((m) => m.orderRef === h.json.data["orderRef"])).length >= 12, 15_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const mine = sink.received.filter((h) => made.some((m) => m.orderRef === h.json.data['orderRef']));
    const succeeded = mine.filter((h) => h.json.type === 'payment.succeeded');
    const distinctSucceeded = new Set(succeeded.map((h) => h.json.id));
    const lost = made.filter((m) => !succeeded.some((h) => h.json.data['orderRef'] === m.orderRef));
    expect(lost).toHaveLength(2); // lost webhooks never arrive...
    for (const m of lost) {
      const status = await ca.get(`/stub/v1/payments/${m.paymentId}`, { headers: auth() });
      await spaced();
      expect(status.json).toMatchObject({ status: 'succeeded' }); // ...but the status API tells the truth, so reconciliation can find them
    }
    expect(succeeded.length - distinctSucceeded.size).toBe(2); // duplicates carry the same event id
    expect(mine.filter((h) => h.json.type === 'payment.failed')).toHaveLength(2); // stale failures after success
    const failedAfter = mine.filter((h) => h.json.type === 'payment.failed').every((h) => Number(h.json.data['seq']) === 1);
    expect(failedAfter).toBe(true);
    for (const h of mine) expect(verifyWebhook(a.env.STUB_WEBHOOK_SECRET, String(h.headers['x-stub-signature']), h.body, Math.floor(Date.now() / 1000))).toBe('ok');
  });
});
