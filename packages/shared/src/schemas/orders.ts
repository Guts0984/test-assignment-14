import { z } from 'zod';
import { RULES } from '../rules/constants.js';
import { ORDER_STATUSES } from '../state/transitions.js';
import { seatIdSchema, uuidSchema } from './common.js';

export const holdRequestSchema = z
  .object({
    seatIds: z.array(seatIdSchema).max(RULES.maxSeatsPerOrder).default([]),
    general: z
      .array(z.object({ zoneId: uuidSchema, quantity: z.number().int().min(1).max(RULES.maxSeatsPerOrder) }).strict())
      .max(RULES.maxSeatsPerOrder)
      .default([]),
  })
  .strict()
  .refine((v) => v.seatIds.length + v.general.reduce((n, g) => n + g.quantity, 0) > 0, { message: 'select at least one seat' })
  .refine((v) => new Set(v.seatIds).size === v.seatIds.length, { message: 'duplicate seat ids' });

export const applyPromoRequestSchema = z.object({ code: z.string().trim().toUpperCase().min(3).max(40) }).strict();

export const orderItemSchema = z.object({
  id: uuidSchema,
  zoneId: uuidSchema,
  seatId: z.number().int().nullable(),
  price: z.number().int(),
  discount: z.number().int(),
  fee: z.number().int(),
});

export const orderSchema = z.object({
  id: uuidSchema,
  eventId: uuidSchema,
  status: z.enum(ORDER_STATUSES),
  /** Where the money of the order's refunds is: none requested, on its way, all returned, or a refund the provider rejected. */
  refundState: z.enum(['none', 'in_progress', 'completed', 'failed']),
  holdExpiresAt: z.string().nullable(),
  serverTime: z.string(),
  promoCode: z.string().nullable(),
  subtotal: z.number().int(),
  discount: z.number().int(),
  fee: z.number().int(),
  total: z.number().int(),
  items: z.array(orderItemSchema),
  createdAt: z.string(),
});

export type OrderResponse = z.infer<typeof orderSchema>;

export const orderListSchema = z.object({ items: z.array(orderSchema) });

export const orderHistorySchema = z.object({
  items: z.array(z.object({ at: z.string(), actorRole: z.string(), actorId: uuidSchema.nullable(), type: z.string(), data: z.record(z.string(), z.unknown()) })),
});
