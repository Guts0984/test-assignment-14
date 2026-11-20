import type { Pool } from 'pg';
import { createProviderClient, createTaskRunner, executeRefund, type ProviderClient, type TaskHandler } from '@ticketing/platform';
import { waitFor } from '@ticketing/testkit';
import type { Client } from '../attacker/index.js';
import { client } from '../attacker/index.js';
import type { BootedApi } from './boot.js';
import { idem } from './event-fixture.js';
import type { TestUser } from './session.js';

export const providerOf = (api: BootedApi): ProviderClient => createProviderClient({ baseUrl: api.env.PAYMENT_PROVIDER_URL, apiKey: api.env.STUB_API_KEY });

export const stubBase = (api: BootedApi): string => api.env.PAYMENT_PROVIDER_URL;

export interface HeldOrder {
  readonly id: string;
  readonly total: number;
  readonly items: readonly { id: string; seatId: number | null }[];
}

export const holdSeats = async (http: Client, eventId: string, user: TestUser, seatIds: readonly number[], general?: { zoneId: string; quantity: number }): Promise<HeldOrder> => {
  const r = await http.post(`/api/events/${eventId}/holds`, { seatIds, general: general ? [general] : [] }, { token: user.token, headers: { 'idempotency-key': idem() } });
  if (r.status !== 200) throw new Error(`hold failed: ${r.text}`);
  return r.json as HeldOrder;
};

export const checkout = async (http: Client, user: TestUser, orderId: string, key = idem()) => {
  const r = await http.post(`/api/orders/${orderId}/checkout`, {}, { token: user.token, headers: { 'idempotency-key': key } });
  return { reply: r, key, body: r.json as { paymentId: string; paymentUrl: string; order: { status: string } } };
};

export const providerPaymentId = (paymentUrl: string): string => paymentUrl.split('/').pop() ?? '';

/** What the buyer does on the provider's page. */
export const click = async (api: BootedApi, providerId: string, action: 'success' | 'failure' | 'close'): Promise<number> => {
  const c = client({ baseUrl: api.baseUrl, sourceIp: '127.0.0.250' });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const r = await c.post(`/stub/pay/${providerId}/${action}`, undefined);
    if (r.status !== 429 && r.status !== 503) return r.status;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return 0;
};

export const orderStatus = async (pool: Pool, orderId: string): Promise<string> =>
  ((await pool.query(`SELECT status::text AS s FROM orders WHERE id = $1`, [orderId])).rows[0] as { s: string }).s;

export const waitForStatus = (pool: Pool, orderId: string, status: string, timeoutMs = 15_000): Promise<string> =>
  waitFor(async () => ((await orderStatus(pool, orderId)) === status ? status : false), timeoutMs);

/** Checkout and approve at the provider; resolves when the order is paid. */
export const payFully = async (api: BootedApi, http: Client, user: TestUser, orderId: string): Promise<{ paymentId: string; providerId: string }> => {
  let { body, reply } = await checkout(http, user, orderId);
  for (let attempt = 0; attempt < 30 && reply.status === 503; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, Number(reply.headers['retry-after'] ?? 1) * 250)));
    ({ body, reply } = await checkout(http, user, orderId));
  }
  if (reply.status !== 200) throw new Error(`checkout failed: ${reply.text}`);
  const providerId = providerPaymentId(body.paymentUrl);
  await click(api, providerId, 'success');
  await waitForStatus(poolOf(api), orderId, 'paid');
  return { paymentId: body.paymentId, providerId };
};

const pools = new WeakMap<object, Pool>();
export const bindPool = (api: BootedApi, pool: Pool): void => void pools.set(api, pool);
const poolOf = (api: BootedApi): Pool => {
  const p = pools.get(api);
  if (!p) throw new Error('call bindPool(api, pool) first');
  return p;
};

/**
 * Plays the role of a worker for the given task kinds: claims every due task and runs its handler. Refund execution
 * uses the real provider call; a throttled call is retried after the advertised delay.
 */
export const drainTasks = async (pool: Pool, provider: ProviderClient, kinds: readonly string[] = ['refund_execute'], rounds = 200): Promise<number> => {
  const handlers: Record<string, TaskHandler> = {
    refund_execute: async (task) => {
      const out = await executeRefund(pool, provider, String(task.payload['refundId']));
      if (out.kind === 'again') return { again: Math.min(out.afterMs, 300) };
      return undefined;
    },
  };
  const runner = createTaskRunner({ pool, handlers, owner: `test-drain-${Math.random()}`, leaseMs: 10_000, retryDelay: () => 100 });
  let ran = 0;
  for (let round = 0; round < rounds; round += 1) {
    const open = await pool.query(`SELECT 1 FROM tasks WHERE status IN ('pending', 'running') AND kind = ANY($1::text[]) LIMIT 1`, [kinds]);
    if (open.rowCount === 0) return ran;
    const due = await pool.query<{ dedupe_key: string }>(`SELECT dedupe_key FROM tasks WHERE status = 'pending' AND run_at <= app_now() AND kind = ANY($1::text[]) ORDER BY run_at LIMIT 200`, [kinds]);
    for (const row of due.rows) if ((await runner.run(row.dedupe_key)) !== 'skipped') ran += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return ran;
};

export const setClock = (http: Client, offsetMs: number) => http.post('/api/_test/clock', { offsetMs });
