import { HttpException } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import type { ErrorCode, ErrorResponse } from '@ticketing/shared';
import { AppException } from './app.exception.js';

const codeForStatus = (status: number): ErrorCode => {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'VALIDATION_FAILED';
  return 'INTERNAL';
};

interface BodyParserError {
  readonly type?: string;
  readonly status?: number;
}

const make = (code: ErrorCode, message: string, requestId: string, details?: Record<string, unknown>): ErrorResponse => ({
  error: { code, message, requestId, ...(details ? { details } : {}) },
});

/** Maps any thrown value to the single public error body. Pure; internal details never leave the server. */
export const toErrorBody = (exception: unknown, requestId: string): ErrorResponse => {
  if (exception instanceof AppException) {
    const { code, message, details } = exception.appError;
    return make(code, message, requestId, details ? { ...details } : undefined);
  }
  if (exception instanceof ZodValidationException) {
    const zodError = exception.getZodError() as { readonly issues?: readonly { readonly path: readonly (string | number)[]; readonly message: string }[] };
    const issues = (zodError.issues ?? []).map((i) => ({ path: i.path.join('.'), message: i.message }));
    return make('VALIDATION_FAILED', 'Request validation failed', requestId, { issues });
  }
  if (exception instanceof HttpException) {
    const code = codeForStatus(exception.getStatus());
    return make(code, code === 'NOT_FOUND' ? 'Resource not found' : code === 'INTERNAL' ? 'Internal error' : exception.message, requestId);
  }
  if (exception instanceof RangeError && /call stack/i.test(exception.message)) return make('VALIDATION_FAILED', 'Request body is nested too deeply', requestId);
  const parser = exception as BodyParserError;
  if (parser.type === 'entity.too.large') return make('PAYLOAD_TOO_LARGE', 'Request body is too large', requestId);
  if (parser.type === 'entity.parse.failed' || parser.type === 'encoding.unsupported' || parser.type === 'charset.unsupported') {
    return make('VALIDATION_FAILED', 'Request body is not valid JSON', requestId);
  }
  if (typeof parser.status === 'number' && parser.status >= 400 && parser.status < 500) return make(codeForStatus(parser.status), 'Bad request', requestId);
  return make('INTERNAL', 'Internal error', requestId);
};
