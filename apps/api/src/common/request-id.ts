import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Attaches a request id (never trusts the client's value) and labels the serving copy. */
export const requestContextMiddleware =
  (instanceId: string) =>
  (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader(REQUEST_ID_HEADER, randomUUID());
    res.setHeader('x-api-instance', instanceId);
    next();
  };
