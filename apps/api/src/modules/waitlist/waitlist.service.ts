import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTxRetry, type RealtimePublisher } from '@ticketing/platform';
import { PG_POOL, RT_PUBLISHER } from '../../infra/tokens.js';
import { appError, err, ok, type Result } from '../../common/result.js';

export interface WaitlistStatus {
  readonly joined: boolean;
  readonly position: number | null;
  readonly offer: { readonly id: string; readonly seatId: number | null; readonly zoneId: string | null; readonly expiresAt: string } | null;
  readonly serverTime: string;
}

@Injectable()
export class WaitlistService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RT_PUBLISHER) private readonly rt: RealtimePublisher,
  ) {}

  /** Only a sold-out event has a waitlist. One entry per account; leaving and rejoining puts you at the back. */
  async join(eventId: string, userId: string, zoneId: string | null): Promise<Result<WaitlistStatus>> {
    const result = await withTxRetry(this.pool, async (tx): Promise<Result<true>> => {
      const ev = (await tx.query<{ status: string }>(`SELECT status FROM events WHERE id = $1`, [eventId])).rows[0];
      if (!ev || ev.status === 'draft') return err(appError('NOT_FOUND', 'Event not found'));
      if (ev.status !== 'sold_out') return err(appError('CONFLICT', 'Tickets are still available, no waitlist needed'));
      if (zoneId) {
        const z = await tx.query(`SELECT 1 FROM event_zones WHERE event_id = $1 AND zone_id = $2`, [eventId, zoneId]);
        if (z.rowCount === 0) return err(appError('NOT_FOUND', 'Zone not found'));
      }
      await tx.query(
        `INSERT INTO waitlist_entries (event_id, user_id, zone_id) VALUES ($1, $2, $3)
         ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'waiting', zone_id = EXCLUDED.zone_id, seq = nextval('waitlist_seq'), created_at = app_now()
         WHERE waitlist_entries.status IN ('left', 'fulfilled')`,
        [eventId, userId, zoneId],
      );
      await tx.query(`SELECT waitlist_offer_next($1)`, [eventId]);
      return ok(true);
    });
    if (!result.ok) return result;
    return ok(await this.status(eventId, userId));
  }

  async status(eventId: string, userId: string): Promise<WaitlistStatus> {
    const e = (await this.pool.query<{ status: string; seq: string; now: Date }>(`SELECT status, seq, app_now() AS now FROM waitlist_entries WHERE event_id = $1 AND user_id = $2`, [eventId, userId])).rows[0];
    const now = (await this.pool.query<{ now: Date }>(`SELECT app_now() AS now`)).rows[0]?.now ?? new Date();
    if (!e) return { joined: false, position: null, offer: null, serverTime: now.toISOString() };
    const ahead = e.status === 'waiting' ? ((await this.pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM waitlist_entries WHERE event_id = $1 AND status = 'waiting' AND seq < $2`, [eventId, e.seq])).rows[0]?.n ?? 0) + 1 : null;
    const offer = (await this.pool.query<{ id: string; seat_id: string | null; zone_id: string | null; expires_at: Date }>(
      `SELECT id, seat_id, zone_id, expires_at FROM waitlist_offers WHERE event_id = $1 AND user_id = $2 AND status = 'active' AND expires_at > app_now()`,
      [eventId, userId],
    )).rows[0];
    return {
      joined: e.status === 'waiting' || e.status === 'offered',
      position: ahead,
      offer: offer ? { id: offer.id, seatId: offer.seat_id === null ? null : Number(offer.seat_id), zoneId: offer.zone_id, expiresAt: offer.expires_at.toISOString() } : null,
      serverTime: now.toISOString(),
    };
  }

  /** Leaving cancels a live offer; its seat goes to the next person at once. */
  async leave(eventId: string, userId: string): Promise<WaitlistStatus> {
    await withTxRetry(this.pool, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`waitlist:${eventId}`]);
      const cancelled = await tx.query<{ id: string }>(`UPDATE waitlist_offers SET status = 'cancelled' WHERE event_id = $1 AND user_id = $2 AND status = 'active' RETURNING id`, [eventId, userId]);
      if (cancelled.rows.length > 0) await tx.query(`UPDATE event_seats SET reserved_for_offer_id = NULL WHERE event_id = $1 AND reserved_for_offer_id = ANY($2::uuid[])`, [eventId, cancelled.rows.map((r) => r.id)]);
      await tx.query(`UPDATE waitlist_entries SET status = 'left' WHERE event_id = $1 AND user_id = $2 AND status IN ('waiting', 'offered')`, [eventId, userId]);
      await tx.query(`SELECT waitlist_offer_next($1)`, [eventId]);
    });
    this.rt.seatsChanged(eventId);
    return this.status(eventId, userId);
  }
}
