import { createHmac, timingSafeEqual } from 'node:crypto';

/** `t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<body>")>` */
export const signWebhook = (secret: string, body: string, unixSeconds: number): string =>
  `t=${unixSeconds},v1=${createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex')}`;

export type SignatureCheck = 'ok' | 'malformed' | 'stale' | 'mismatch';

/** Verifies in constant time and rejects replays older than `toleranceSeconds` (delayed chaos webhooks stay inside it). */
export const verifyWebhook = (secret: string, header: string | undefined, body: string, nowSeconds: number, toleranceSeconds = 600): SignatureCheck => {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match?.[1] || !match[2]) return 'malformed';
  const timestamp = Number(match[1]);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return 'stale';
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(match[2], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'ok' : 'mismatch';
};
