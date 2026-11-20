import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/** Page and size are bounded: invalid or negative values are a validation error, never a crash. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Database ids that arrive as JSON numbers: positive safe integers only (2^53 and beyond silently lose precision). */
export const seatIdSchema = z.number().int().safe().positive();

export const roleSchema = z.enum(['buyer', 'organizer', 'scanner', 'finance']);
export type Role = z.infer<typeof roleSchema>;

export const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
