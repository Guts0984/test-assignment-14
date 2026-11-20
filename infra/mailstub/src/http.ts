import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MailStore, StoredMessage } from './store.js';

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const summary = (m: StoredMessage) => ({
  id: m.id, messageId: m.messageId, receivedAt: m.receivedAt, from: m.from, to: m.to, subject: m.subject,
  attachments: m.attachments.map((a, index) => ({ index, filename: a.filename, contentType: a.contentType, size: a.content.length })),
});

const page = (messages: readonly StoredMessage[]): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Mail stub</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#1b1b1f}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left;vertical-align:top}pre{white-space:pre-wrap}</style></head>
<body><h1>Mail stub inbox (${messages.length})</h1><table><thead><tr><th>Received</th><th>To</th><th>Subject</th><th>Attachments</th></tr></thead><tbody>
${messages.map((m) => `<tr><td>${escape(m.receivedAt)}</td><td>${escape(m.to.join(', '))}</td><td><a href="/messages/${m.id}">${escape(m.subject)}</a></td><td>${m.attachments.map((a, i) => `<a href="/messages/${m.id}/attachments/${i}">${escape(a.filename)}</a>`).join(' ')}</td></tr>`).join('')}
</tbody></table></body></html>`;

const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', ...extra });
  res.end(body);
};

const route = (store: MailStore, req: IncomingMessage, res: ServerResponse): void => {
  const url = new URL(req.url ?? '/', 'http://mailstub');
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, 'application/json', '{"status":"ok"}');
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', page(store.list({})));
  if (req.method === 'DELETE' && url.pathname === '/messages') {
    store.clear();
    return send(res, 204, 'text/plain', '');
  }
  if (req.method === 'GET' && url.pathname === '/messages') {
    const list = store.list({ to: url.searchParams.get('to') ?? undefined, q: url.searchParams.get('q') ?? undefined });
    return send(res, 200, 'application/json', JSON.stringify({ items: list.map(summary), total: list.length }));
  }
  const message = parts[0] === 'messages' && parts[1] ? store.get(parts[1]) : undefined;
  if (req.method === 'GET' && message && parts.length === 2) return send(res, 200, 'application/json', JSON.stringify({ ...summary(message), text: message.text, html: message.html }));
  if (req.method === 'GET' && message && parts[2] === 'attachments' && parts[3] !== undefined) {
    const attachment = message.attachments[Number(parts[3])];
    if (attachment) return send(res, 200, attachment.contentType, attachment.content, { 'content-disposition': `attachment; filename="${attachment.filename.replace(/[^\w.-]/g, '_')}"` });
  }
  return send(res, 404, 'application/json', '{"error":"not found"}');
};

export const startHttp = (store: MailStore, port: number): Promise<{ readonly port: number; readonly close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => route(store, req, res));
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const address = server.address();
      resolve({ port: typeof address === 'object' && address ? address.port : port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
