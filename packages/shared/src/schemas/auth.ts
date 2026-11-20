import { z } from 'zod';
import { roleSchema, uuidSchema } from './common.js';

const email = z.string().trim().toLowerCase().email().max(254);

export const registerRequestSchema = z
  .object({ email, password: z.string().min(10).max(128), displayName: z.string().trim().min(1).max(120) })
  .strict();

export const loginRequestSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(20).max(200).optional() }).strict();

export const tokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSeconds: z.number().int(),
  user: z.object({ id: uuidSchema, email: z.string(), displayName: z.string(), role: roleSchema }),
});

export const meSchema = z.object({ id: uuidSchema, email: z.string(), displayName: z.string(), role: roleSchema });
