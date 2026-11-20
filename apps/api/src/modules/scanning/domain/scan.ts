import type { Pool } from 'pg';
import { parseTicketCode } from '@ticketing/platform';

export type ScanReason = 'ok' | 'invalid_code' | 'wrong_event' | 'already_entered' | 'transferred' | 'refunded' | 'event_cancelled';

export interface ScanResult {
  readonly result: 'allow' | 'deny';
  readonly reason: ScanReason;
  readonly message: string;
  readonly enteredAt: string | null;
  readonly gate: string | null;
  readonly ticket: { readonly zoneName: string; readonly row: string | null; readonly seat: number | null } | null;
}

const deny = (reason: Exclude<ScanReason, 'ok'>, message: string, extra: Partial<ScanResult> = {}): ScanResult => ({ result: 'deny', reason, message, enteredAt: null, gate: null, ticket: null, ...extra });

/** Entry time on the venue's clock (events are in Kyiv), as the gate staff read it. */
const hhmm = (d: Date): string => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

/** Only staff assigned to the event may use it; anything else looks like a missing event. */
export const isAssigned = async (pool: Pool, eventId: string, userId: string): Promise<boolean> =>
  (await pool.query(`SELECT 1 FROM event_staff WHERE event_id = $1 AND user_id = $2`, [eventId, userId])).rowCount === 1;

/**
 * Checks a ticket in. The decision is one atomic UPDATE (valid, current QR version, not yet entered, this event):
 * of any number of simultaneous scans of the same ticket exactly one passes. Refusals explain why.
 */
export const scanTicket = async (pool: Pool, secret: string, input: { readonly eventId: string; readonly scannerId: string; readonly code: string; readonly gate: string }): Promise<ScanResult> => {
  const log = (ticketId: string | null, result: ScanResult): Promise<unknown> =>
    pool.query(`INSERT INTO ticket_scans (ticket_id, event_id, scanner_id, gate, result, reason) VALUES ($1, $2, $3, $4, $5, $6)`, [ticketId, input.eventId, input.scannerId, input.gate, result.result, result.reason]);

  const code = parseTicketCode(secret, input.code);
  if (!code) {
    const r = deny('invalid_code', 'Invalid or forged code');
    await log(null, r);
    return r;
  }
  const detail = async () =>
    (await pool.query<{ status: string; event_id: string; qr_version: number; entered_at: Date | null; gate: string | null; zone_name: string; row_label: string | null; number: number | null; ev_status: string }>(
      `SELECT t.status, t.event_id, t.qr_version, t.entered_at, t.gate, z.name AS zone_name, s.row_label, s.number, e.status AS ev_status
       FROM tickets t JOIN zones z ON z.id = t.zone_id JOIN events e ON e.id = t.event_id LEFT JOIN seats s ON s.id = t.seat_id WHERE t.id = $1`,
      [code.ticketId],
    )).rows[0];

  const passed =
    code.eventId === input.eventId
      ? await pool.query<{ entered_at: Date }>(
          `UPDATE tickets t SET entered_at = app_now(), gate = $4 FROM events e
           WHERE t.id = $1 AND t.event_id = $2 AND t.qr_version = $3 AND t.status = 'valid' AND t.entered_at IS NULL AND e.id = t.event_id AND e.status <> 'cancelled'
           RETURNING t.entered_at`,
          [code.ticketId, input.eventId, code.version, input.gate],
        )
      : null;
  const t = await detail();
  if (passed && passed.rowCount === 1 && t) {
    const r: ScanResult = { result: 'allow', reason: 'ok', message: 'Welcome', enteredAt: passed.rows[0]?.entered_at.toISOString() ?? null, gate: input.gate, ticket: { zoneName: t.zone_name, row: t.row_label, seat: t.number } };
    await log(code.ticketId, r);
    return r;
  }
  let r: ScanResult;
  if (!t) r = deny('invalid_code', 'Ticket not found');
  else if (t.event_id !== input.eventId || code.eventId !== input.eventId) r = deny('wrong_event', 'This ticket is for another event');
  else if (t.ev_status === 'cancelled') r = deny('event_cancelled', 'The event was cancelled');
  else if (t.status === 'refunded') r = deny('refunded', 'This ticket was refunded');
  else if (t.qr_version !== code.version) r = deny('transferred', 'This ticket was transferred; the code is no longer valid');
  else if (t.entered_at) r = deny('already_entered', `Already entered at ${hhmm(t.entered_at)}, gate ${t.gate ?? '?'}`, { enteredAt: t.entered_at.toISOString(), gate: t.gate });
  else r = deny('invalid_code', 'Ticket cannot be used');
  await log(code.ticketId, r);
  return r;
};

export const scanStats = async (pool: Pool, eventId: string) => {
  const r = (await pool.query<{ entered: number; expected: number; total: number }>(
    `SELECT COUNT(*) FILTER (WHERE entered_at IS NOT NULL)::int AS entered, COUNT(*) FILTER (WHERE entered_at IS NULL)::int AS expected, COUNT(*)::int AS total FROM tickets WHERE event_id = $1 AND status = 'valid'`,
    [eventId],
  )).rows[0];
  return { eventId, entered: r?.entered ?? 0, expected: r?.expected ?? 0, total: r?.total ?? 0 };
};

export const scannerEvents = async (pool: Pool, userId: string) => {
  const res = await pool.query<{ id: string; title: string; starts_at: Date; status: string }>(
    `SELECT e.id, e.title, e.starts_at, e.status FROM event_staff s JOIN events e ON e.id = s.event_id WHERE s.user_id = $1 ORDER BY e.starts_at DESC LIMIT 100`,
    [userId],
  );
  return res.rows.map((r) => ({ id: r.id, title: r.title, startsAt: r.starts_at.toISOString(), status: r.status }));
};
