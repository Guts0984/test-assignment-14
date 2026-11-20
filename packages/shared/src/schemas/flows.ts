import { z } from 'zod';
import { isoDateTimeSchema, seatIdSchema, uuidSchema } from './common.js';
import { orderSchema } from './orders.js';

export const checkoutResponseSchema = z.object({ order: orderSchema, paymentId: uuidSchema, paymentUrl: z.string() });

export const refundRequestSchema = z.object({ itemIds: z.array(uuidSchema).min(1).max(6).optional() }).strict();
export const financeRefundRequestSchema = z.object({ reason: z.string().trim().min(3).max(500), itemIds: z.array(uuidSchema).min(1).max(50).optional() }).strict();

export const refundQuoteSchema = z.object({
  orderId: uuidSchema,
  items: z.array(z.object({ itemId: uuidSchema, refundable: z.boolean(), kind: z.string().nullable(), price: z.number().int(), fee: z.number().int(), reason: z.string().nullable() })),
  total: z.number().int(),
});

export const refundSchema = z.object({
  id: uuidSchema,
  orderId: uuidSchema,
  kind: z.enum(['user', 'finance', 'event_cancelled', 'late_payment']),
  status: z.enum(['requested', 'pending', 'succeeded', 'failed']),
  amount: z.number().int(),
  priceAmount: z.number().int(),
  feeAmount: z.number().int(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});

export const ticketSchema = z.object({
  id: uuidSchema,
  orderId: uuidSchema,
  eventId: uuidSchema,
  eventTitle: z.string(),
  startsAt: z.string(),
  venueName: z.string(),
  zoneName: z.string(),
  row: z.string().nullable(),
  seat: z.number().int().nullable(),
  status: z.enum(['valid', 'refunded']),
  /** Signed code for the QR image. It changes when the ticket is transferred. */
  code: z.string(),
  enteredAt: z.string().nullable(),
});
export const ticketListSchema = z.object({ items: z.array(ticketSchema) });
export const transferRequestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();

export const scanRequestSchema = z.object({ code: z.string().trim().min(10).max(400), gate: z.string().trim().min(1).max(20).default('1') }).strict();
export const scanResultSchema = z.object({
  result: z.enum(['allow', 'deny']),
  reason: z.enum(['ok', 'invalid_code', 'wrong_event', 'already_entered', 'transferred', 'refunded', 'event_cancelled']),
  message: z.string(),
  enteredAt: z.string().nullable(),
  gate: z.string().nullable(),
  ticket: z.object({ zoneName: z.string(), row: z.string().nullable(), seat: z.number().int().nullable() }).nullable(),
});
export const scanStatsSchema = z.object({ eventId: uuidSchema, entered: z.number().int(), expected: z.number().int(), total: z.number().int() });
export const scannerEventListSchema = z.object({ items: z.array(z.object({ id: uuidSchema, title: z.string(), startsAt: z.string(), status: z.string() })) });
export const staffRequestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();

export const waitlistRequestSchema = z.object({ zoneId: uuidSchema.nullable().default(null) }).strict();
export const waitlistStatusSchema = z.object({
  joined: z.boolean(),
  position: z.number().int().nullable(),
  offer: z.object({ id: uuidSchema, seatId: seatIdSchema.nullable(), zoneId: uuidSchema.nullable(), expiresAt: z.string() }).nullable(),
  serverTime: z.string(),
});

export const queueViewSchema = z.object({
  status: z.enum(['waiting', 'admitted', 'selecting', 'done', 'expired', 'left']),
  position: z.number().int().nullable(),
  etaSeconds: z.number().int().nullable(),
  mustStartBefore: z.string().nullable(),
  queueActive: z.boolean(),
  serverTime: z.string(),
});

export const rescheduleRequestSchema = z.object({ startsAt: isoDateTimeSchema }).strict();
export const cancellationProgressSchema = z.object({
  status: z.string(),
  total: z.number().int(),
  requested: z.number().int(),
  pending: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  amountTotal: z.number().int(),
  amountRefunded: z.number().int(),
});

const periodQuery = {
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
};
export const periodQuerySchema = z.object(periodQuery);
export const organizerSalesQuerySchema = z.object({ ...periodQuery, eventId: uuidSchema.optional() });
export const organizerSalesSchema = z.object({
  from: z.string(),
  to: z.string(),
  byHour: z.array(z.object({ hour: z.string(), tickets: z.number().int(), gross: z.number().int(), refunds: z.number().int() })),
  byZone: z.array(z.object({ zoneId: uuidSchema, zoneName: z.string(), tickets: z.number().int(), gross: z.number().int() })),
  events: z.array(z.object({ id: uuidSchema, title: z.string(), capacity: z.number().int(), sold: z.number().int(), fillPercent: z.number() })),
  funnel: z.object({ joinedQueue: z.number().int(), admitted: z.number().int(), paid: z.number().int() }),
});
export const financeReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  sales: z.number().int(),
  serviceFees: z.number().int(),
  commission: z.number().int(),
  refunds: z.number().int(),
  payouts: z.number().int(),
  byOrganizer: z.array(z.object({ organizerId: uuidSchema, organizerName: z.string(), sales: z.number().int(), refunds: z.number().int(), commission: z.number().int(), payouts: z.number().int() })),
});
export const reconciliationSchema = z.object({
  ledgerSum: z.number().int(),
  unbalancedTransactions: z.number().int(),
  balanceMismatches: z.array(z.object({ account: z.string(), balance: z.number().int(), entriesSum: z.number().int() })),
  rollupMismatches: z.number().int(),
  providerFindings: z.array(z.object({ kind: z.string(), ref: z.string(), detail: z.record(z.string(), z.unknown()), foundAt: z.string(), resolved: z.boolean() })),
  stuck: z.object({ pendingPayments: z.number().int(), pendingRefunds: z.number().int(), failedRefunds: z.number().int() }),
  ok: z.boolean(),
});
export const jobListSchema = z.object({
  items: z.array(z.object({ id: uuidSchema, kind: z.string(), dedupeKey: z.string(), status: z.string(), attempts: z.number().int(), maxAttempts: z.number().int(), lastError: z.string().nullable(), runAt: z.string(), updatedAt: z.string(), stuck: z.boolean() })),
});
