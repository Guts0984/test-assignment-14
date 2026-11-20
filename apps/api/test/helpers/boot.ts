import type { INestApplication } from '@nestjs/common';
import { hostReachableRedisUrl, hostReachableUrl, type TestDb } from '@ticketing/testkit';
import { createApp } from '../../src/bootstrap.js';
import { loadEnv, type Env } from '../../src/config/env.schema.js';

export interface BootedApi {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly env: Env;
  readonly close: () => Promise<void>;
}

/** Starts the real application on an ephemeral port, wired to a private test database and the shared Redis. */
export const bootApi = async (db: TestDb, overrides: Readonly<Record<string, string>> = {}): Promise<BootedApi> => {
  const parsed = loadEnv({
    ...process.env,
    DATABASE_URL: db.url,
    REDIS_URL: hostReachableRedisUrl(process.env['REDIS_URL'] ?? 'redis://localhost:6379'),
    NODE_ENV: 'test',
    DB_POOL_MAX: '10',
    TEST_CLOCK_ENABLED: 'true',
    LOGIN_THROTTLE_IP_MAX: '100000',
    LOGIN_THROTTLE_ACCOUNT_IP_MAX: '100000',
    ...overrides,
  });
  if (!parsed.ok) throw new Error(`invalid test env: ${parsed.errors.join('; ')}`);
  const app = await createApp(parsed.env);
  await app.listen(Number(parsed.env.API_PORT === 3001 && !overrides['API_PORT'] ? 0 : parsed.env.API_PORT), '0.0.0.0');
  const address = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');
  return { app, baseUrl: hostReachableUrl(address).replace(/\/$/, ''), env: parsed.env, close: () => app.close() };
};
