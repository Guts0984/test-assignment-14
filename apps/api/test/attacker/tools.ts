import { connect } from 'node:net';
import type { Client, Reply } from './client.js';

/** Fires `send` at a steady rate for `durationMs` and collects every reply (no coordinated omission: each fires on schedule). */
export const flood = async (opts: { readonly send: () => Promise<Reply>; readonly rps: number; readonly durationMs: number }): Promise<readonly Reply[]> => {
  const total = Math.max(1, Math.floor((opts.rps * opts.durationMs) / 1000));
  const gap = 1000 / opts.rps;
  const started = Date.now();
  const pending: Promise<Reply>[] = [];
  for (let i = 0; i < total; i += 1) {
    const wait = started + i * gap - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    pending.push(opts.send().catch((): Reply => ({ status: 0, headers: {}, text: '', json: undefined, ms: 0 })));
  }
  return Promise.all(pending);
};

/** Times a function. */
export const timed = async <T>(fn: () => Promise<T>): Promise<{ readonly value: T; readonly ms: number }> => {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
};

export const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

/** Sends arbitrary bytes over a raw TCP socket (malformed requests, CRLF tricks) and returns what the server answered. */
export const raw = (baseUrl: string, bytes: string, timeoutMs = 5_000): Promise<string> =>
  new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let data = '';
    socket.setTimeout(timeoutMs, () => socket.destroy());
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', (d) => {
      data += d.toString('utf8');
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });

/** Opens a connection and trickles the request line/headers one byte at a time (slowloris). Returns a handle to stop it. */
export const slowRequest = (baseUrl: string, intervalMs = 200): { readonly stop: () => void; readonly closed: Promise<void> } => {
  const url = new URL(baseUrl);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  const bytes = Buffer.from(`GET /api/health HTTP/1.1\r\nHost: ${url.host}\r\nX-Slow: ${'a'.repeat(5_000)}\r\n`);
  let i = 0;
  const timer = setInterval(() => {
    if (i < bytes.length) socket.write(bytes.subarray(i, i + 1));
    i += 1;
  }, intervalMs);
  const closed = new Promise<void>((resolve) => {
    socket.on('close', () => resolve());
    socket.on('error', () => resolve());
  });
  return { stop: () => { clearInterval(timer); socket.destroy(); }, closed };
};

export const statusCounts = (replies: readonly Reply[]): Readonly<Record<number, number>> =>
  replies.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

export type { Client };
