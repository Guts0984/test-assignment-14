import { createServer } from 'node:net';
import type { TestDb } from '@ticketing/testkit';
import { bootApi, type BootedApi } from './boot.js';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });

/**
 * Boots the application so that its payment client talks to its own stub and the stub's webhooks come back
 * to its own webhook endpoint, all over real HTTP: the full payment loop, no fakes.
 */
export const bootLoop = async (db: TestDb, extra: Readonly<Record<string, string>> = {}): Promise<BootedApi> => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  return bootApi(db, {
    API_PORT: String(port),
    API_PUBLIC_URL: base,
    PAYMENT_PROVIDER_URL: `${base}/stub`,
    PAYMENT_WEBHOOK_URL: `${base}/api/webhooks/payments`,
    STUB_DISPATCH_INTERVAL_MS: '100',
    STUB_CHAOS_MAX_DELAY_MS: '1500',
    ...extra,
  });
};
