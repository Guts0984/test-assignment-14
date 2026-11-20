import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttp, startSmtp, createStore } from '@ticketing/mailstub';
import { createTestDb, waitFor, type TestDb } from '@ticketing/testkit';
import { bulkPaidOrders } from './helpers/bulk.js';
import { startFakeProvider, type FakeProvider } from './helpers/fake-provider.js';
import { startTestWorker } from './helpers/worker.js';
import type { RunningWorker } from '../src/start-worker.js';

let tdb: TestDb;
let provider: FakeProvider;
const store = createStore(500);
const closers: (() => Promise<unknown>)[] = [];
let workers: RunningWorker[] = [];
const prefix = `m${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  tdb = await createTestDb();
  provider = await startFakeProvider();
  const smtp = await startSmtp(store, 0);
  const http = await startHttp(store, 0);
  closers.push(smtp.close, http.close);
  workers = [1, 2, 3].map((n) => startTestWorker({ db: tdb, providerUrl: provider.url, smtpPort: smtp.port, prefix, id: `mail-worker-${n}` }));
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  for (const close of closers) await close();
  await provider.close();
  await tdb.drop();
});

const q = async (sql: string, params: unknown[] = []) => (await tdb.pool.query(sql, params)).rows as Record<string, unknown>[];
const emailOf = async (userId: string): Promise<string> => (await q(`SELECT email FROM users WHERE id = $1`, [userId]))[0]?.['email'] as string;

describe('ticket emails with a PDF', () => {
  it('a paid order gets exactly one mail with a PDF, although three workers compete and the task is re-run', async () => {
    const bulk = await bulkPaidOrders(tdb.pool, 1, 2);
    const to = await emailOf(bulk.userIds[0] as string);
    await waitFor(() => store.list({ to }).length >= 1, 20_000);
    const [mail] = store.list({ to });
    expect(mail?.subject).toContain('Your tickets for Concert');
    expect(mail?.text).toContain('Tickets: 2');
    expect(mail?.attachments).toHaveLength(1);
    expect(mail?.attachments[0]?.contentType).toBe('application/pdf');
    expect(mail?.attachments[0]?.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(mail?.attachments[0]?.content.length).toBeGreaterThan(2_000);
    // run the same task again and again, on every worker
    for (let i = 0; i < 3; i += 1) {
      await q(`UPDATE tasks SET status = 'pending', attempts = 0, run_at = app_now() WHERE dedupe_key = $1`, [`email:tickets:${bulk.orderIds[0]}`]);
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    expect(store.list({ to })).toHaveLength(1);
    expect((await q(`SELECT status::text AS s, attempts FROM emails WHERE dedupe_key = $1`, [`email:tickets:${bulk.orderIds[0]}:to`]))[0]).toMatchObject({ s: 'sent', attempts: 1 });
  });

  it('a crash between "sent" and "marked sent" does not produce a second mail (deterministic Message-ID)', async () => {
    const bulk = await bulkPaidOrders(tdb.pool, 1, 1);
    const to = await emailOf(bulk.userIds[0] as string);
    await waitFor(() => store.list({ to }).length === 1, 20_000);
    await q(`UPDATE emails SET status = 'pending', sent_at = NULL WHERE dedupe_key = $1`, [`email:tickets:${bulk.orderIds[0]}:to`]); // as if the worker died right after SMTP accepted the mail
    await q(`UPDATE tasks SET status = 'pending', attempts = 0, run_at = app_now() WHERE dedupe_key = $1`, [`email:tickets:${bulk.orderIds[0]}`]);
    await waitFor(async () => (await q(`SELECT status::text AS s FROM emails WHERE dedupe_key = $1`, [`email:tickets:${bulk.orderIds[0]}:to`]))[0]?.['s'] === 'sent', 15_000);
    expect(store.list({ to })).toHaveLength(1);
  });
});

describe('other mails', () => {
  it('a ticket transfer mails the new owner (with the new ticket) and the sender', async () => {
    const bulk = await bulkPaidOrders(tdb.pool, 2, 1);
    const [from, toUser] = bulk.userIds as [string, string];
    const ticket = (await q(`SELECT id FROM tickets WHERE order_id = $1`, [bulk.orderIds[0]]))[0]?.['id'] as string;
    await q(`INSERT INTO tasks (kind, dedupe_key, payload) VALUES ('email', $1, $2::jsonb)`, [`email:transfer:${ticket}:2`, JSON.stringify({ template: 'transfer', ticketId: ticket, toUserId: toUser, fromUserId: from })]);
    const toEmail = await emailOf(toUser);
    await waitFor(() => store.list({ to: toEmail }).some((m) => m.subject.includes('sent you a ticket')), 20_000);
    const received = store.list({ to: toEmail }).find((m) => m.subject.includes('sent you a ticket'));
    expect(received?.attachments[0]?.contentType).toBe('application/pdf');
    const fromEmail = await emailOf(from);
    await waitFor(() => store.list({ to: fromEmail }).some((m) => m.subject.includes('You sent a ticket')), 20_000);
  });

  it('an unknown template fails loudly (visible to finance) instead of being dropped', async () => {
    await q(`INSERT INTO tasks (kind, dedupe_key, payload, max_attempts) VALUES ('email', 'email:bogus:1', '{"template":"nope"}'::jsonb, 2)`);
    await waitFor(async () => (await q(`SELECT status::text AS s FROM tasks WHERE dedupe_key = 'email:bogus:1'`))[0]?.['s'] === 'failed', 15_000);
    expect((await q(`SELECT last_error FROM tasks WHERE dedupe_key = 'email:bogus:1'`))[0]?.['last_error']).toContain('unknown email template');
  });
});
