import { z } from 'zod';
import { RULES } from '../rules/constants.js';
import { EVENT_STATUSES } from '../state/transitions.js';
import { isoDateTimeSchema, paginationSchema, seatIdSchema, uuidSchema } from './common.js';

const price = z.number().int().min(100).max(RULES.maxPriceKopecks);
const tierSchema = z.object({ name: z.string().trim().min(1).max(60), price }).strict();

/** Pricing: tiers by name+price, then which zone or which individually selected seats belong to which tier. */
export const priceAssignmentSchema = z
  .object({
    tierIndex: z.number().int().min(0).max(19),
    zoneIds: z.array(uuidSchema).max(200).default([]),
    seatIds: z.array(seatIdSchema).max(12_000).default([]),
  })
  .strict();

export const pricingSchema = z
  .object({ tiers: z.array(tierSchema).min(1).max(20), assignments: z.array(priceAssignmentSchema).min(1).max(100) })
  .strict();

export const createEventRequestSchema = z
  .object({
    venueId: uuidSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5_000).default(''),
    category: z.string().trim().min(1).max(40),
    startsAt: isoDateTimeSchema,
    salesStartAt: isoDateTimeSchema,
    perPersonLimit: z.number().int().min(1).max(RULES.maxPerPersonLimit).default(RULES.defaultTicketsPerPerson),
    pricing: pricingSchema,
  })
  .strict();

export const updateEventRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5_000).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    startsAt: isoDateTimeSchema.optional(),
    salesStartAt: isoDateTimeSchema.optional(),
    perPersonLimit: z.number().int().min(1).max(RULES.maxPerPersonLimit).optional(),
    pricing: pricingSchema.optional(),
  })
  .strict();

export const blockSeatsRequestSchema = z
  .object({ seatIds: z.array(seatIdSchema).min(1).max(12_000), blocked: z.boolean() })
  .strict();

export const eventSummarySchema = z.object({
  id: uuidSchema,
  title: z.string(),
  city: z.string(),
  category: z.string(),
  startsAt: z.string(),
  salesStartAt: z.string(),
  status: z.enum(EVENT_STATUSES),
  minPrice: z.number().int().nullable(),
  maxPrice: z.number().int().nullable(),
  capacity: z.number().int(),
  soldCount: z.number().int(),
  hasSeats: z.boolean(),
  venueName: z.string(),
});

export const eventDetailSchema = eventSummarySchema.extend({
  description: z.string(),
  venueId: uuidSchema,
  organizerId: uuidSchema,
  perPersonLimit: z.number().int(),
  rescheduledAt: z.string().nullable(),
  queueActive: z.boolean(),
  zones: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      kind: z.enum(['seated', 'general']),
      capacity: z.number().int(),
      available: z.number().int(),
      price: z.number().int().nullable(),
    }),
  ),
});

export const eventSearchQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  city: z.string().trim().max(80).optional(),
  category: z.string().trim().max(40).optional(),
  dateFrom: isoDateTimeSchema.optional(),
  dateTo: isoDateTimeSchema.optional(),
  priceMin: z.coerce.number().int().min(0).max(RULES.maxPriceKopecks).optional(),
  priceMax: z.coerce.number().int().min(0).max(RULES.maxPriceKopecks).optional(),
  hasSeats: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['date', 'price', 'title']).default('date'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const eventSearchResponseSchema = z.object({
  items: z.array(eventSummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});

/** Static geometry, columnar so a 10 000-seat hall stays a few hundred KB. */
export const seatLayoutSchema = z.object({
  eventId: uuidSchema,
  zones: z.array(z.object({ id: uuidSchema, name: z.string(), kind: z.enum(['seated', 'general']), capacity: z.number().int(), tierIndex: z.number().int().nullable() })),
  tiers: z.array(z.object({ name: z.string(), price: z.number().int() })),
  seats: z.object({
    id: z.array(z.number().int()),
    zone: z.array(z.number().int()),
    tier: z.array(z.number().int()),
    row: z.array(z.string()),
    number: z.array(z.number().int()),
    x: z.array(z.number()),
    y: z.array(z.number()),
  }),
});

/** Live part: one status code per seat in layout order (0 free, 1 held, 2 sold, 3 blocked). */
export const seatStateSchema = z.object({
  eventId: uuidSchema,
  seq: z.number().int(),
  serverTime: z.string(),
  status: z.array(z.number().int().min(0).max(3)),
  heldUntil: z.array(z.tuple([z.number().int(), z.number().int()])),
  general: z.array(z.object({ zoneId: uuidSchema, available: z.number().int() })),
});
