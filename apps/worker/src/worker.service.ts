import { hostname } from 'node:os';
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Env } from './config/env.schema.js';
import { startWorker, type RunningWorker } from './start-worker.js';

export const WORKER_ENV = Symbol('WORKER_ENV');

/** Nest wrapper: starts the worker when the process boots and stops it on shutdown. */
@Injectable()
export class WorkerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('worker');
  private running: RunningWorker | undefined;

  constructor(@Inject(WORKER_ENV) private readonly env: Env) {}

  onModuleInit(): void {
    const e = this.env;
    this.running = startWorker({
      databaseUrl: e.DATABASE_URL, dbPoolMax: e.DB_POOL_MAX, redisUrl: e.REDIS_URL, qrSecret: e.QR_SIGNING_SECRET, publicUrl: e.API_PUBLIC_URL,
      providerUrl: e.PAYMENT_PROVIDER_URL, providerApiKey: e.STUB_API_KEY, smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, from: e.MAIL_FROM },
      // The host name is the container id: replicas of one service never share a lease owner name.
      instanceId: `${e.WORKER_INSTANCE_ID}@${hostname()}`, concurrency: e.WORKER_CONCURRENCY, refundRps: e.WORKER_REFUND_RPS, rehydrateIntervalMs: e.REHYDRATE_INTERVAL_MS,
      reconcileIntervalMs: e.RECONCILE_INTERVAL_MS, queueActivateAt: e.QUEUE_ACTIVATE_AT, queueMaxSelecting: e.QUEUE_MAX_SELECTING,
      log: (m) => this.logger.log(m),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.running?.stop();
  }
}
