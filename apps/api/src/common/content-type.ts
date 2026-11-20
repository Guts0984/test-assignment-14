import type { NextFunction, Request, Response } from 'express';
import type { ErrorResponse } from '@ticketing/shared';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Bodies must be JSON. Anything else is a clear 415 instead of being half-parsed. */
export const jsonOnlyMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const length = Number(req.headers['content-length'] ?? 0);
  const chunked = req.headers['transfer-encoding'] !== undefined;
  const hasBody = length > 0 || chunked;
  if (BODY_METHODS.has(req.method) && hasBody && !req.is('application/json')) {
    const body: ErrorResponse = { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json', requestId: String(res.getHeader('x-request-id') ?? '') } };
    res.status(415).json(body);
    return;
  }
  next();
};

const hasNullByte = (value: unknown): boolean => {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(hasNullByte);
  if (value !== null && typeof value === 'object') return Object.entries(value as Record<string, unknown>).some(([k, v]) => k.includes('\u0000') || hasNullByte(v));
  return false;
};

/** NUL bytes cannot be stored in Postgres text; refuse them everywhere with a clear 400 instead of a 500. */
export const rejectNullBytes = (req: Request, res: Response, next: NextFunction): void => {
  if (hasNullByte(req.body) || hasNullByte(req.query) || hasNullByte(req.params)) {
    const body: ErrorResponse = { error: { code: 'VALIDATION_FAILED', message: 'Input contains an invalid character', requestId: String(res.getHeader('x-request-id') ?? '') } };
    res.status(400).json(body);
    return;
  }
  next();
};
