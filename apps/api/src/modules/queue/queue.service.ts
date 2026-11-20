import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { RealtimePublisher, VirtualQueue } from '@ticketing/platform';
import { PG_POOL, RT_PUBLISHER, VIRTUAL_QUEUE } from '../../infra/tokens.js';
import { appError, err, ok, type Result } from '../../common/result.js';

export interface QueueViewOut {
  readonly status: 'waiting' | 'admitted' | 'selecting' | 'done' | 'expired' | 'left';
  readonly position: number | null;
  readonly etaSeconds: number | null;
  readonly mustStartBefore: string | null;
  readonly queueActive: boolean;
  readonly serverTime: string;
}

@Injectable()
export class QueueService {
  private readonly lastAdmit = new Map<string, number>();

  constructor(
    @Inject(VIRTUAL_QUEUE) private readonly queue: VirtualQueue,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RT_PUBLISHER) private readonly rt: RealtimePublisher,
  ) {}

  private async visible(eventId: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM events WHERE id = $1 AND status IN ('on_sale', 'rescheduled', 'sold_out')`, [eventId]);
    return r.rowCount === 1;
  }

  private async out(eventId: string, userId: string): Promise<QueueViewOut | null> {
    const v = await this.queue.view(eventId, userId);
    if (!v) return null;
    const now = (await this.pool.query<{ now: Date }>(`SELECT app_now() AS now`)).rows[0]?.now ?? new Date();
    return { status: v.status, position: v.position, etaSeconds: v.etaSeconds, mustStartBefore: v.mustStartBefore?.toISOString() ?? null, queueActive: v.queueActive, serverTime: now.toISOString() };
  }

  /** Joins (or re-reads) the person's single place. A reload, a second tab or the other api copy all get the same place. */
  async join(eventId: string, userId: string): Promise<Result<QueueViewOut>> {
    if (!(await this.visible(eventId))) return err(appError('NOT_FOUND', 'Event not found'));
    const joined = await this.queue.join(eventId, userId);
    if (joined.status === 'admitted') this.rt.toUser(userId, 'queue.update', { eventId, status: 'admitted' });
    const view = await this.out(eventId, userId);
    return view ? ok(view) : err(appError('INTERNAL', 'queue entry vanished'));
  }

  /** Polling also nudges admission (at most twice a second per event per copy), so the line moves even without a worker. */
  async view(eventId: string, userId: string): Promise<QueueViewOut | null> {
    const now = Date.now();
    if (now - (this.lastAdmit.get(eventId) ?? 0) > 500) {
      this.lastAdmit.set(eventId, now);
      for (const id of await this.queue.admit(eventId).catch(() => [] as readonly string[])) this.rt.toUser(id, 'queue.update', { eventId, status: 'admitted' });
    }
    return this.out(eventId, userId);
  }

  async leave(eventId: string, userId: string): Promise<QueueViewOut | null> {
    await this.queue.leave(eventId, userId);
    return this.out(eventId, userId);
  }
}
