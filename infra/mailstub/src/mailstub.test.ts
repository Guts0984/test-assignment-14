import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttp } from './http.js';
import { startSmtp } from './smtp.js';
import { createStore } from './store.js';
import { loadEnv } from './config/env.schema.js';

const store = createStore(50);
let smtpPort = 0;
let httpPort = 0;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  const smtp = await startSmtp(store, 0);
  const http = await startHttp(store, 0);
  smtpPort = smtp.port;
  httpPort = http.port;
  closers.push(smtp.close, http.close);
});
afterAll(async () => {
  for (const close of closers) await close();
});

const transport = () => createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, tls: { rejectUnauthorized: false }, ignoreTLS: true });
const get = async (path: string): Promise<Response> => fetch(`http://127.0.0.1:${httpPort}${path}`);

describe('mail stub', () => {
  it('accepts mail over SMTP and shows it over HTTP, attachments included', async () => {
    await transport().sendMail({
      from: 'tickets@example.test', to: 'ann@example.test', subject: 'Your tickets', text: 'Hello Ann', messageId: '<m1@test>',
      attachments: [{ filename: 'tickets.pdf', content: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' }],
    });
    const list = (await (await get('/messages?to=ANN@example.test')).json()) as { items: { id: string; subject: string; attachments: { index: number; size: number }[] }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.subject).toBe('Your tickets');
    const first = list.items[0];
    const attachment = await get(`/messages/${first?.id}/attachments/0`);
    expect(attachment.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await attachment.arrayBuffer()).toString()).toBe('%PDF-1.4 fake');
    const detail = (await (await get(`/messages/${first?.id}`)).json()) as { text: string };
    expect(detail.text).toContain('Hello Ann');
  });

  it('the same Message-ID is stored once, even when sent twice or in parallel', async () => {
    const t = transport();
    await Promise.all(Array.from({ length: 5 }, () => t.sendMail({ from: 'a@example.test', to: 'bob@example.test', subject: 'once', text: 'x', messageId: '<dedupe-1@test>' })));
    const list = (await (await get('/messages?to=bob@example.test')).json()) as { total: number };
    expect(list.total).toBe(1);
  });

  it('the inbox page escapes hostile subjects', async () => {
    await transport().sendMail({ from: 'a@example.test', to: 'eve@example.test', subject: '<script>alert(1)</script>', text: 'x', messageId: '<xss@test>' });
    const html = await (await get('/')).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('unknown routes and ids are a 404', async () => {
    expect((await get('/messages/not-a-real-id')).status).toBe(404);
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/health')).status).toBe(200);
  });

  it('the store is capped', () => {
    const small = createStore(3);
    for (let i = 0; i < 10; i += 1) small.add({ messageId: `<${i}@x>`, from: 'a', to: ['b'], subject: `s${i}`, text: '', html: null, attachments: [] });
    expect(small.list({}).map((m) => m.subject)).toEqual(['s9', 's8', 's7']);
  });

  it('env: defaults for ports, rejects junk', () => {
    expect(loadEnv({}).ok).toBe(true);
    expect(loadEnv({ SMTP_PORT: 'abc' }).ok).toBe(false);
    expect(loadEnv({ SMTP_PORT: '70000' }).ok).toBe(false);
  });
});
