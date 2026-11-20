import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { RealtimePublisher } from '@ticketing/platform';
import { PG_POOL, RT_PUBLISHER } from '../../infra/tokens.js';
import { financeRefund, listRefunds, refundQuote, userRefund } from './domain/refund-flow.js';

@Injectable()
export class RefundsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RT_PUBLISHER) private readonly rt: RealtimePublisher,
  ) {}

  quote = (orderId: string, userId: string) => refundQuote(this.pool, orderId, userId);
  list = (orderId: string, userId: string) => listRefunds(this.pool, orderId, userId);

  async refund(input: { orderId: string; userId: string; itemIds: readonly string[] | undefined; key: string }) {
    const result = await userRefund(this.pool, input);
    if (result.ok) await this.announce(input.orderId);
    return result;
  }

  async financeRefund(input: { orderId: string; actorId: string; reason: string; itemIds: readonly string[] | undefined; key: string }) {
    const result = await financeRefund(this.pool, input);
    if (result.ok) await this.announce(input.orderId);
    return result;
  }

  private async announce(orderId: string): Promise<void> {
    const o = (await this.pool.query<{ user_id: string; event_id: string }>(`SELECT user_id, event_id FROM orders WHERE id = $1`, [orderId])).rows[0];
    if (!o) return;
    this.rt.toUser(o.user_id, 'order.updated', { orderId });
    this.rt.seatsChanged(o.event_id);
  }
}
