import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { hostReachableUrl } from '@ticketing/testkit';
import type { Role } from '@ticketing/shared';
import { signAccessToken } from '../../src/modules/auth/domain/tokens.js';

/** Helpers for tests that drive the deployed compose stack from outside (nginx, published postgres, docker CLI). */
export const STACK_URL = process.env['STACK_URL'] ?? 'http://127.0.0.1:8080';
const REPO = resolve(__dirname, '../../../..');

export const openPool = (max = 8): pg.Pool => new pg.Pool({ connectionString: hostReachableUrl(process.env['DATABASE_URL'] ?? ''), max });

export const mintSession = async (pool: pg.Pool, userId: string, role: Role): Promise<string> => {
  const family = randomUUID();
  await pool.query(`INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2::uuid, md5($2::text), now() + interval '1 day')`, [userId, family]);
  return signAccessToken(process.env['JWT_ACCESS_SECRET'] ?? '', 900, { sub: userId, role, sid: family });
};

const compose = (args: readonly string[]): string =>
  execFileSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml', ...args], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The operations an operator would run against the stack: kill -9 a worker, scale workers, wipe or restart Redis. */
export const ops = {
  killWorkers: (): string => compose(['kill', '-s', 'SIGKILL', 'worker']),
  scaleWorkers: (n: number): string => compose(['up', '-d', '--no-recreate', '--scale', `worker=${n}`, 'worker']),
  flushRedis: (): string => compose(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL']),
  restartRedis: (): string => compose(['restart', 'redis']),
  workerCount: (): number => compose(['ps', '--status', 'running', '-q', 'worker']).split('\n').filter(Boolean).length,
};

export const api = async <T>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: T }> => {
  const res = await fetch(`${STACK_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
};

export const poll = async (fn: () => Promise<boolean>, timeoutMs: number, everyMs = 1_000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
};
