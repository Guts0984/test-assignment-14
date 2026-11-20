import { z } from 'zod';
import { uuidSchema } from './common.js';

export const venueSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  city: z.string(),
  capacity: z.number().int(),
  zones: z.array(z.object({ id: uuidSchema, key: z.string(), name: z.string(), kind: z.enum(['seated', 'general']), capacity: z.number().int() })),
});

export type VenueResponse = z.infer<typeof venueSchema>;

export const venueListSchema = z.object({ items: z.array(venueSchema) });

/** Geometry of a hall: same columnar shape as an event layout, without pricing. */
export const venueGeometrySchema = z.object({
  venueId: uuidSchema,
  zones: venueSchema.shape.zones,
  seats: z.object({
    id: z.array(z.number().int()),
    zone: z.array(z.number().int()),
    row: z.array(z.string()),
    number: z.array(z.number().int()),
    x: z.array(z.number()),
    y: z.array(z.number()),
  }),
});
