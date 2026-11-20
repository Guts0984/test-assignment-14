import { z } from 'zod';
import { uuidSchema } from './common.js';

export const createPromoRequestSchema = z
  .object({
    code: z.string().trim().toUpperCase().min(3).max(40).regex(/^[A-Z0-9_-]+$/),
    kind: z.enum(['percent', 'fixed']),
    value: z.number().int().min(1).max(10_000_000),
    usageLimit: z.number().int().min(1).max(1_000_000),
    eventId: uuidSchema.nullable().default(null),
  })
  .strict()
  .refine((v) => v.kind !== 'percent' || v.value <= 100, { message: 'percent must be 1..100', path: ['value'] });

export const promoSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  kind: z.enum(['percent', 'fixed']),
  value: z.number().int(),
  usageLimit: z.number().int(),
  usedCount: z.number().int(),
  eventId: uuidSchema.nullable(),
});

export const promoListSchema = z.object({ items: z.array(promoSchema) });
