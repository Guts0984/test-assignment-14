import type { ErrorCode } from '@ticketing/shared';

/** Expected failures travel as values; only programmer errors throw. */
export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type Result<T, E = AppError> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E = AppError>(error: E): Result<never, E> => ({ ok: false, error });
export const appError = (code: ErrorCode, message: string, details?: Readonly<Record<string, unknown>>): AppError =>
  details ? { code, message, details } : { code, message };
