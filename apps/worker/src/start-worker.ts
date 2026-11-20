import {
  DEFAULT_QUEUE_CONFIG, createLimiter, createPgPool, createProviderClient, createRealtimePublisher, createRedis, createRedisQueueCache, createTaskQueue, createTaskRunner,
  createTaskWorker, createVirtualQueue, startRehydrator,
} from '@ticketing/platform';
import { createMailer } from './email/mailer.js';
import { buildHandlers } from './handlers/index.js';
import { admissionRound, expirySweep, loop, reconcileRound } from './periodic/loops.js';

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly dbPoolMax: number;
  readonly redisUrl: string;
  readonly redisPrefix?: string | undefined;
  readonly qrSecret: string;
  readonly publicUrl: string;
  readonly providerUrl: string;
  readonly providerApiKey: string;
  readonly smtp: { readonly host: string; readonly port: number; readonly from: string };
  readonly instanceId: string;
  readonly concurrency: number;
  readonly refundRps: number;
  readonly rehydrateIntervalMs: number;
  readonly reconcileIntervalMs: number;
  readonly queueActivateAt: number;
  readonly queueMaxSelecting: number;
  /** Tests only: shorter lease/stall windows and backoff so crashes and retries finish quickly. */
  readonly tuning?: { readonly leaseMs?: number; readonly lockDurationMs?: number; readonly stalledIntervalMs?: number; readonly retryDelay?: (attempt: number, random: number) => number; readonly admissionMs?: number; readonly sweepMs?: number };
  readonly log?: (message: string) => void;
}

export interface RunningWorker {
  readonly stop: () => Promise<void>;
}

/**
 * Wires one worker process: BullMQ executor + the durable task runner, the rehydrator that rebuilds the executor from
 * Postgres (start-up and every few seconds, so an emptied Redis heals itself), and the periodic loops. Any number of
 * copies can run side by side: task claims, admission and reconciliation are all safe to run concurrently.
 */
export const startWorker = (cfg: WorkerConfig): RunningWorker => {
  const log = cfg.log ?? (() => undefined);
  const pool = createPgPool({ connectionString: cfg.databaseUrl, max: cfg.dbPoolMax, onError: (e) => log(`postgres: ${e.message}`) });
  const redis = createRedis(cfg.redisUrl, { connectionName: cfg.instanceId, onError: (e) => log(`redis: ${e.message}`) });
  const bullConnection = createRedis(cfg.redisUrl, { connectionName: `${cfg.instanceId}-bull`, onError: () => undefined });
  const workerConnection = createRedis(cfg.redisUrl, { connectionName: `${cfg.instanceId}-bull-w`, onError: () => undefined });
  const queue = createTaskQueue({ connection: bullConnection, prefix: cfg.redisPrefix });
  const limiter = createLimiter(redis, { onError: 'closed', timeoutMs: 500 });
  const rt = createRealtimePublisher({ redis, pool });
  const provider = createProviderClient({ baseUrl: cfg.providerUrl, apiKey: cfg.providerApiKey });
  const mailer = createMailer(cfg.smtp);
  const vq = createVirtualQueue({ pool, cache: createRedisQueueCache(redis), cfg: { ...DEFAULT_QUEUE_CONFIG, activateAt: cfg.queueActivateAt, maxSelecting: cfg.queueMaxSelecting } });

  const handlers = buildHandlers({ pool, provider, limiter, rt, mailer, queue: vq, qrSecret: cfg.qrSecret, publicUrl: cfg.publicUrl, refundRps: cfg.refundRps });
  const runner = createTaskRunner({
    pool, handlers, owner: cfg.instanceId, leaseMs: cfg.tuning?.leaseMs ?? 30_000,
    retryDelay: cfg.tuning?.retryDelay,
    wake: (key, runAt, delay) => queue.enqueue(key, runAt, delay),
    onError: (message, task) => log(`task ${task.dedupeKey} failed (attempt ${task.attempts}): ${message}`),
  });
  const executor = createTaskWorker({ connection: workerConnection, prefix: cfg.redisPrefix, runner, concurrency: cfg.concurrency, lockDurationMs: cfg.tuning?.lockDurationMs, stalledIntervalMs: cfg.tuning?.stalledIntervalMs, onError: (e) => log(`executor: ${e.message}`) });
  const onError = (error: unknown): void => log(`loop error: ${error instanceof Error ? error.message : String(error)}`);

  const stopRehydrator = startRehydrator({ pool, enqueue: (k, at, d) => queue.enqueue(k, at, d), horizonMs: 60_000, intervalMs: cfg.rehydrateIntervalMs, onError });
  const loops = [
    loop(() => admissionRound(pool, vq, rt), cfg.tuning?.admissionMs ?? 1_000, onError),
    loop(() => expirySweep(pool, rt), cfg.tuning?.sweepMs ?? 20_000, onError),
    loop(() => reconcileRound(pool, provider), cfg.reconcileIntervalMs, onError),
  ];
  log(`worker ${cfg.instanceId} started`);

  return {
    stop: async () => {
      stopRehydrator();
      loops.forEach((l) => l.stop());
      await executor.close().catch(() => undefined);
      await queue.close().catch(() => undefined);
      mailer.close();
      for (const c of [redis, bullConnection, workerConnection]) c.disconnect();
      await pool.end().catch(() => undefined);
    },
  };
};
