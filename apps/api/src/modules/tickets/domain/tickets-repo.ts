import type { Pool } from 'pg';
import { enqueue, history, lockEvent, signTicketCode } from '@ticketing/platform';
import { RULES } from '@ticketing/shared';
import { appError, err, ok, type Result } from '../../../common/result.js';
import { requestHash, runIdempotent, type JsonValue } from '../../orders/domain/idempotency.js';

interface TicketRow {
  id: string;
  order_id: string;
  event_id: string;
  event_title: string;
  starts_at: Date;
  venue_name: string;
  zone_name: string;
  row_label: string | null;
  number: number | null;
  status: 'valid' | 'refunded';
  qr_version: number;
  entered_at: Date | null;
}

const SELECT = `SELECT t.id, t.order_id, t.event_id, e.title AS event_title, e.starts_at, v.name AS venue_name, z.name AS zone_name, s.row_label, s.number,
  t.status, t.qr_version, t.entered_at FROM tickets t JOIN events e ON e.id = t.event_id JOIN venues v ON v.id = e.venue_id JOIN zones z ON z.id = t.zone_id LEFT JOIN seats s ON s.id = t.seat_id`;

export const toTicketView = (secret: string, r: TicketRow): { readonly [key: string]: JsonValue } => ({
  id: r.id,
  orderId: r.order_id,
  eventId: r.event_id,
  eventTitle: r.event_title,
  startsAt: r.starts_at.toISOString(),
  venueName: r.venue_name,
  zoneName: r.zone_name,
  row: r.row_label,
  seat: r.number,
  status: r.status,
  code: signTicketCode(secret, { ticketId: r.id, eventId: r.event_id, version: r.qr_version }),
  enteredAt: r.entered_at?.toISOString() ?? null,
});

/** Tickets the user owns now (a transferred ticket is gone from the sender's list). */
export const listTickets = async (pool: Pool, secret: string, userId: string) => {
  const res = await pool.query<TicketRow>(`${SELECT} WHERE t.owner_id = $1 ORDER BY e.starts_at DESC, t.created_at DESC LIMIT 500`, [userId]);
  return res.rows.map((r) => toTicketView(secret, r));
};

export const getTicket = async (pool: Pool, secret: string, id: string, userId: string) => {
  const r = (await pool.query<TicketRow>(`${SELECT} WHERE t.id = $1 AND t.owner_id = $2`, [id, userId])).rows[0];
  return r ? toTicketView(secret, r) : null;
};

/**
 * Hands a ticket to another registered user. The QR version increases, so the old code is dead the instant the
 * transaction commits; the new owner's code is new. Allowed until one hour before the start, never after entry,
 * and never once the event is cancelled (cancellation holds the event lock exclusively).
 */
export const transferTicket = (pool: Pool, secret: string, input: { readonly ticketId: string; readonly fromUserId: string; readonly toEmail: string; readonly key: string }) =>
  runIdempotent<{ readonly [key: string]: JsonValue }>(
    pool,
    { userId: input.fromUserId, scope: `transfer:${input.ticketId}`, key: input.key, hash: requestHash({ ticketId: input.ticketId, to: input.toEmail }) },
    async (tx): Promise<Result<{ readonly [key: string]: JsonValue }>> => {
      const peek = (await tx.query<{ event_id: string }>(`SELECT event_id FROM tickets WHERE id = $1 AND owner_id = $2`, [input.ticketId, input.fromUserId])).rows[0];
      if (!peek) return err(appError('NOT_FOUND', 'Ticket not found'));
      await lockEvent(tx, peek.event_id, true);
      const t = (await tx.query<{ id: string; order_id: string; status: string; entered_at: Date | null; qr_version: number; lead_ms: number; ev_status: string }>(
        `SELECT t.id, t.order_id, t.status, t.entered_at, t.qr_version, (EXTRACT(EPOCH FROM (e.starts_at - app_now())) * 1000)::float8 AS lead_ms, e.status AS ev_status
         FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = $1 AND t.owner_id = $2 FOR UPDATE OF t`,
        [input.ticketId, input.fromUserId],
      )).rows[0];
      if (!t) return err(appError('NOT_FOUND', 'Ticket not found'));
      if (t.status !== 'valid') return err(appError('TRANSFER_NOT_ALLOWED', 'This ticket was refunded', { reason: 'refunded' }));
      if (t.entered_at) return err(appError('TRANSFER_NOT_ALLOWED', 'This ticket was already used', { reason: 'already_used' }));
      if (!['on_sale', 'sold_out', 'rescheduled'].includes(t.ev_status)) return err(appError('TRANSFER_NOT_ALLOWED', 'Tickets of this event can no longer be transferred', { reason: 'event_not_active' }));
      if (t.lead_ms < RULES.transferCutoffMs) return err(appError('TRANSFER_NOT_ALLOWED', 'Tickets can be transferred until one hour before the start', { reason: 'too_late' }));
      const to = (await tx.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [input.toEmail])).rows[0];
      if (!to) return err(appError('TRANSFER_NOT_ALLOWED', 'The recipient must have an account', { reason: 'recipient_unknown' }));
      if (to.id === input.fromUserId) return err(appError('TRANSFER_NOT_ALLOWED', 'You already own this ticket', { reason: 'same_owner' }));
      const version = t.qr_version + 1;
      await tx.query(`UPDATE tickets SET owner_id = $2, qr_version = $3 WHERE id = $1`, [t.id, to.id, version]);
      await tx.query(`INSERT INTO ticket_transfers (ticket_id, from_user, to_user, qr_version) VALUES ($1, $2, $3, $4)`, [t.id, input.fromUserId, to.id, version]);
      await history(tx, t.order_id, 'buyer', input.fromUserId, 'ticket_transferred', { ticketId: t.id, to: to.id, qrVersion: version });
      await enqueue(tx, 'email', `email:transfer:${t.id}:${version}`, { template: 'transfer', ticketId: t.id, toUserId: to.id, fromUserId: input.fromUserId });
      const view = (await tx.query<TicketRow>(`${SELECT} WHERE t.id = $1`, [t.id])).rows[0];
      return view ? ok(toTicketView(secret, view)) : err(appError('INTERNAL', 'ticket vanished'));
    },
  );
