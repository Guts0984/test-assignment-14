import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { RealtimePublisher } from '@ticketing/platform';
import type { Env } from '../../config/env.schema.js';
import { ENV, PG_POOL, RT_PUBLISHER } from '../../infra/tokens.js';
import { getTicket, listTickets, transferTicket } from './domain/tickets-repo.js';

@Injectable()
export class TicketsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RT_PUBLISHER) private readonly rt: RealtimePublisher,
    @Inject(ENV) private readonly env: Env,
  ) {}

  list = (userId: string) => listTickets(this.pool, this.env.QR_SIGNING_SECRET, userId);
  get = (id: string, userId: string) => getTicket(this.pool, this.env.QR_SIGNING_SECRET, id, userId);

  async transfer(input: { ticketId: string; fromUserId: string; toEmail: string; key: string }) {
    const result = await transferTicket(this.pool, this.env.QR_SIGNING_SECRET, input);
    if (result.ok) {
      const to = (await this.pool.query<{ owner_id: string }>(`SELECT owner_id FROM tickets WHERE id = $1`, [input.ticketId])).rows[0]?.owner_id;
      this.rt.toUser(input.fromUserId, 'ticket.transferred', { ticketId: input.ticketId, direction: 'out' });
      if (to) this.rt.toUser(to, 'ticket.transferred', { ticketId: input.ticketId, direction: 'in' });
    }
    return result;
  }
}
