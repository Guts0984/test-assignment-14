import { createServer, type Server } from 'node:http';

export interface FakeProvider {
  readonly url: string;
  readonly requests: number[];
  readonly refundKeys: Map<string, string>;
  readonly setMode: (mode: { readonly chaos?: boolean; readonly alwaysDown?: boolean }) => void;
  /** Largest number of requests received inside any window of one second. */
  readonly maxPerSecond: () => number;
  /** Largest number of requests the provider ACCEPTED (did not throttle) inside any one-second window. */
  readonly maxAcceptedPerSecond: () => number;
  readonly throttled: () => number;
  readonly close: () => Promise<void>;
}

/**
 * A stand-in for the payment provider with the documented behaviour that matters to the worker: at most 20 requests per
 * second (429 + Retry-After beyond), every tenth request a 503 in chaos mode, idempotent refunds. It records every request
 * it receives so tests can prove the rate limit was never exceeded.
 */
const window = (stamps: readonly number[]): number => {
  const sorted = [...stamps].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < sorted.length; i += 1) {
    while ((sorted[i] ?? 0) - (sorted[j] ?? 0) >= 1_000) j += 1;
    best = Math.max(best, i - j + 1);
  }
  return best;
};

export const startFakeProvider = async (limitPerSecond = 20): Promise<FakeProvider> => {
  const requests: number[] = [];
  const refundKeys = new Map<string, string>();
  const admitted: number[] = [];
  const accepted: number[] = [];
  let throttled = 0;
  let chaos = false;
  let down = false;
  let counter = 0;
  let nextRef = 0;

  const server: Server = createServer((req, res) => {
    const now = Date.now();
    requests.push(now);
    counter += 1;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
      };
      while (admitted.length > 0 && now - (admitted[0] ?? 0) >= 1_000) admitted.shift();
      if (down) return json(503, { error: 'down' });
      if (admitted.length >= limitPerSecond) {
        throttled += 1;
        return json(429, { error: 'rate' }, { 'retry-after': '1' });
      }
      admitted.push(now);
      accepted.push(now);
      if (chaos && counter % 10 === 0) return json(503, { error: 'chaos' });
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reference?: string; amount?: number; paymentId?: string }) : {};
      if (req.method === 'POST' && req.url === '/v1/refunds') {
        const key = String(req.headers['idempotency-key'] ?? '');
        if (!refundKeys.has(key)) refundKeys.set(key, `ref_${(nextRef += 1)}`);
        return json(200, { id: refundKeys.get(key), status: 'succeeded', amount: body.amount ?? 0, paymentId: body.paymentId ?? '' });
      }
      return json(404, { error: 'unknown' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    refundKeys,
    setMode: (m) => {
      if (m.chaos !== undefined) chaos = m.chaos;
      if (m.alwaysDown !== undefined) down = m.alwaysDown;
    },
    throttled: () => throttled,
    maxAcceptedPerSecond: () => window(accepted),
    maxPerSecond: () => window(requests),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
