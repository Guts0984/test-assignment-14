import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS_BY_CODE, type ErrorResponse } from '@ticketing/shared';
import { toErrorBody } from './error-body.js';
import { REQUEST_ID_HEADER } from './request-id.js';

const logger = new Logger('errors');

const send = (req: Request, res: Response, exception: unknown): void => {
  const requestId = String(res.getHeader(REQUEST_ID_HEADER) ?? '');
  const body: ErrorResponse = toErrorBody(exception, requestId);
  if (body.error.code === 'INTERNAL') {
    logger.error(`${requestId} ${req.method} ${req.path}: ${exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)}`);
  }
  const retry = body.error.details?.['retryAfterSeconds'];
  if (typeof retry === 'number') res.setHeader('Retry-After', String(retry));
  res.status(HTTP_STATUS_BY_CODE[body.error.code]).json(body);
};

/** One error format for every endpoint (controllers, guards, pipes). */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    send(http.getRequest<Request>(), http.getResponse<Response>(), exception);
  }
}

/** Same format for errors raised before Nest routing (body parser: too large, malformed JSON). */
export const errorMiddleware = (error: unknown, req: Request, res: Response, _next: NextFunction): void => send(req, res, error);
