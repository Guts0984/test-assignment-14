import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from './error-response.dto.js';

const DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Validation failed (code VALIDATION_FAILED / IDEMPOTENCY_KEY_REQUIRED)',
  401: 'Missing or invalid credentials (code UNAUTHENTICATED)',
  403: 'Not allowed for this role or resource (code FORBIDDEN)',
  404: 'Not found (code NOT_FOUND)',
  409: 'Conflict with current state (codes CONFLICT, SEAT_UNAVAILABLE, LIMIT_EXCEEDED, ...)',
  413: 'Body too large (code PAYLOAD_TOO_LARGE)',
  415: 'Unsupported media type (code UNSUPPORTED_MEDIA_TYPE)',
  422: 'Business rule violated (codes PROMO_INVALID, REFUND_NOT_ALLOWED, ...)',
  429: 'Rate limited (code RATE_LIMITED, Retry-After header)',
  500: 'Unexpected failure (code INTERNAL)',
};

/** Declares the shared error body for every documented failure status on a controller or route. */
export const ApiErrors = (...statuses: readonly number[]): MethodDecorator & ClassDecorator =>
  applyDecorators(...(statuses.length > 0 ? statuses : [400, 401, 403, 404, 409, 422, 429, 500]).map((status) =>
    ApiResponse({ status, description: DESCRIPTIONS[status] ?? 'Error', type: ErrorResponseDto }),
  ));
