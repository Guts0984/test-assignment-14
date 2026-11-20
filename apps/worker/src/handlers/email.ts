import { signTicketCode, type TaskHandler, type TaskRow } from '@ticketing/platform';
import { renderTicketsPdf, type PdfTicket } from '../email/pdf.js';
import { cancelledMail, payoutMail, refundMail, rescheduledMail, ticketsMail, transferInMail, transferOutMail, waitlistMail, type Mail } from '../email/templates.js';
import { payloadString, type HandlerDeps } from './deps.js';

interface Prepared {
  readonly suffix: string;
  readonly to: string;
  readonly mail: Mail;
  readonly pdf?: readonly PdfTicket[];
}

const ticketsOf = async (d: HandlerDeps, where: string, param: string): Promise<readonly PdfTicket[]> => {
  const res = await d.pool.query<{ id: string; event_id: string; qr_version: number; title: string; venue: string; starts_at: Date; zone: string; row_label: string | null; number: number | null }>(
    `SELECT t.id, t.event_id, t.qr_version, e.title, v.name AS venue, e.starts_at, z.name AS zone, s.row_label, s.number
     FROM tickets t JOIN events e ON e.id = t.event_id JOIN venues v ON v.id = e.venue_id JOIN zones z ON z.id = t.zone_id LEFT JOIN seats s ON s.id = t.seat_id
     WHERE ${where} AND t.status = 'valid' ORDER BY s.row_label, s.number, t.id`,
    [param],
  );
  return res.rows.map((r) => ({ id: r.id, code: signTicketCode(d.qrSecret, { ticketId: r.id, eventId: r.event_id, version: r.qr_version }), title: r.title, venue: r.venue, startsAt: r.starts_at, zone: r.zone, row: r.row_label, seat: r.number }));
};

const orderContext = async (d: HandlerDeps, orderId: string) =>
  (await d.pool.query<{ email: string; title: string; starts_at: Date; previous_starts_at: Date | null; venue: string; total: number }>(
    `SELECT u.email, e.title, e.starts_at, e.previous_starts_at, v.name AS venue, o.total FROM orders o JOIN users u ON u.id = o.user_id JOIN events e ON e.id = o.event_id JOIN venues v ON v.id = e.venue_id WHERE o.id = $1`,
    [orderId],
  )).rows[0];

/** Works out who gets what for one email task. Pure reads; sending is separate so it can be retried safely. */
const prepare = async (d: HandlerDeps, task: TaskRow): Promise<readonly Prepared[]> => {
  const template = payloadString(task, 'template');
  if (template === 'tickets') {
    const orderId = payloadString(task, 'orderId');
    const o = await orderContext(d, orderId);
    if (!o) return [];
    const pdf = await ticketsOf(d, 't.order_id = $1', orderId);
    return [{ suffix: 'to', to: o.email, mail: ticketsMail({ title: o.title, startsAt: o.starts_at, venue: o.venue, count: pdf.length, total: o.total }), pdf }];
  }
  if (template === 'refund') {
    const r = (await d.pool.query<{ email: string; title: string; amount: number }>(
      `SELECT u.email, e.title, r.amount FROM refunds r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = o.user_id JOIN events e ON e.id = o.event_id WHERE r.id = $1`,
      [payloadString(task, 'refundId')],
    )).rows[0];
    return r ? [{ suffix: 'to', to: r.email, mail: refundMail({ title: r.title, amount: r.amount }) }] : [];
  }
  if (template === 'event_cancelled') {
    const r = (await d.pool.query<{ email: string; title: string; starts_at: Date; amount: number }>(
      `SELECT u.email, e.title, e.starts_at, r.amount FROM refunds r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = o.user_id JOIN events e ON e.id = o.event_id WHERE r.id = $1`,
      [payloadString(task, 'refundId')],
    )).rows[0];
    return r ? [{ suffix: 'to', to: r.email, mail: cancelledMail({ title: r.title, startsAt: r.starts_at, amount: r.amount }) }] : [];
  }
  if (template === 'rescheduled') {
    const o = await orderContext(d, payloadString(task, 'orderId'));
    return o ? [{ suffix: 'to', to: o.email, mail: rescheduledMail({ title: o.title, oldStart: o.previous_starts_at, newStart: o.starts_at }) }] : [];
  }
  if (template === 'transfer') {
    const ticketId = payloadString(task, 'ticketId');
    const r = (await d.pool.query<{ title: string; starts_at: Date; to_email: string; to_name: string; from_email: string; from_name: string }>(
      `SELECT e.title, e.starts_at, tu.email AS to_email, tu.display_name AS to_name, fu.email AS from_email, fu.display_name AS from_name
       FROM tickets t JOIN events e ON e.id = t.event_id JOIN users tu ON tu.id = $2 JOIN users fu ON fu.id = $3 WHERE t.id = $1`,
      [ticketId, payloadString(task, 'toUserId'), payloadString(task, 'fromUserId')],
    )).rows[0];
    if (!r) return [];
    const pdf = await ticketsOf(d, 't.id = $1', ticketId);
    return [
      { suffix: 'in', to: r.to_email, mail: transferInMail({ title: r.title, startsAt: r.starts_at, from: r.from_name }), pdf },
      { suffix: 'out', to: r.from_email, mail: transferOutMail({ title: r.title, to: r.to_name }) },
    ];
  }
  if (template === 'waitlist_offer') {
    const r = (await d.pool.query<{ email: string; title: string; expires_at: Date }>(
      `SELECT u.email, e.title, w.expires_at FROM waitlist_offers w JOIN users u ON u.id = w.user_id JOIN events e ON e.id = w.event_id WHERE w.id = $1`,
      [payloadString(task, 'offerId')],
    )).rows[0];
    return r ? [{ suffix: 'to', to: r.email, mail: waitlistMail({ title: r.title, expiresAt: r.expires_at }) }] : [];
  }
  if (template === 'payout') {
    const r = (await d.pool.query<{ email: string; title: string; amount: number }>(
      `SELECT u.email, e.title, p.amount::int AS amount FROM payouts p JOIN users u ON u.id = p.organizer_id JOIN events e ON e.id = p.event_id WHERE p.id = $1`,
      [payloadString(task, 'payoutId')],
    )).rows[0];
    return r ? [{ suffix: 'to', to: r.email, mail: payoutMail({ title: r.title, amount: r.amount }) }] : [];
  }
  throw new Error(`unknown email template "${template}"`);
};

/**
 * Sends the mails of one task at most once visibly: the `emails` row (unique dedupe key) records progress, the
 * Message-ID is derived from the key so a crash between "sent" and "marked sent" cannot show the mail twice, and a
 * finished mail is never sent again by a re-run or a second worker.
 */
export const emailHandler = (d: HandlerDeps): TaskHandler => async (task) => {
  for (const p of await prepare(d, task)) {
    const key = `${task.dedupeKey}:${p.suffix}`;
    const messageId = `<${key.replace(/[^\w.:-]/g, '_')}@tickets.local>`;
    await d.pool.query(
      `INSERT INTO emails (dedupe_key, to_email, subject, template, payload, message_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (dedupe_key) DO NOTHING`,
      [key, p.to, p.mail.subject, payloadString(task, 'template'), JSON.stringify(task.payload), messageId],
    );
    const row = (await d.pool.query<{ status: string }>(`SELECT status::text AS status FROM emails WHERE dedupe_key = $1`, [key])).rows[0];
    if (row?.status === 'sent') continue;
    const attachments = p.pdf && p.pdf.length > 0 ? [{ filename: 'tickets.pdf', content: await renderTicketsPdf(p.pdf), contentType: 'application/pdf' }] : undefined;
    await d.pool.query(`UPDATE emails SET attempts = attempts + 1 WHERE dedupe_key = $1`, [key]);
    await d.mailer.send({ to: p.to, subject: p.mail.subject, text: p.mail.text, messageId, attachments });
    await d.pool.query(`UPDATE emails SET status = 'sent', sent_at = app_now() WHERE dedupe_key = $1`, [key]);
  }
  if (payloadString(task, 'template') === 'waitlist_offer') {
    d.rt.toUser(payloadString(task, 'userId'), 'waitlist.offer', { eventId: payloadString(task, 'eventId'), offerId: payloadString(task, 'offerId') });
  }
};
