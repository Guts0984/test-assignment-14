import { z } from 'zod';

/** Stable machine-readable error codes returned by every endpoint. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'SEAT_UNAVAILABLE',
  'LIMIT_EXCEEDED',
  'HOLD_EXPIRED',
  'PROMO_INVALID',
  'REFUND_NOT_ALLOWED',
  'TRANSFER_NOT_ALLOWED',
  'QUEUE_REQUIRED',
  'INTERNAL',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** The single error body shape used by all endpoints and declared in OpenAPI. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
