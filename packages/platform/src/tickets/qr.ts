import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TicketCode {
  readonly ticketId: string;
  readonly eventId: string;
  readonly version: number;
}

const b64 = (text: string): string => Buffer.from(text).toString('base64url');

const mac = (secret: string, payload: string): Buffer => createHmac('sha256', secret).update(`qr1.${payload}`).digest();

/** `v1.<payload>.<signature>`: signed by the server, so a forged or edited code is refused. */
export const signTicketCode = (secret: string, code: TicketCode): string => {
  const payload = b64(`${code.ticketId}.${code.eventId}.${code.version}`);
  return `v1.${payload}.${mac(secret, payload).toString('base64url')}`;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Returns the contents only if the signature is valid (constant-time comparison); otherwise null. */
export const parseTicketCode = (secret: string, raw: string): TicketCode | null => {
  const parts = raw.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2] || raw.length > 400) return null;
  const given = Buffer.from(parts[2], 'base64url');
  const expected = mac(secret, parts[1]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [ticketId, eventId, version] = Buffer.from(parts[1], 'base64url').toString('utf8').split('.');
  if (!ticketId || !eventId || !version || !UUID.test(ticketId) || !UUID.test(eventId) || !/^\d{1,9}$/.test(version)) return null;
  return { ticketId, eventId, version: Number(version) };
};
