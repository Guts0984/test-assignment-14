import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Env } from '../../config/env.schema.js';
import { ENV, PG_POOL } from '../../infra/tokens.js';
import { dispatchDue } from './domain/dispatcher.js';

const post = async (url: string, headers: Readonly<Record<string, string>>, body: string): Promise<number> => {
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5_000) });
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
};

/** Background delivery of provider webhooks from the outbox table (runs in every api copy, safely). */
@Injectable()
export class StubDispatcher implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('stub-dispatcher');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.env.STUB_DISPATCH_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await dispatchDue({ pool: this.pool, url: this.env.PAYMENT_WEBHOOK_URL, secret: this.env.STUB_WEBHOOK_SECRET, post });
    } catch (error) {
      this.logger.warn(`dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
