import { HttpException } from '@nestjs/common';
import { HTTP_STATUS_BY_CODE } from '@ticketing/shared';
import type { AppError, Result } from './result.js';

/** Carries an AppError to the global exception filter. Thin: controllers turn failed Results into this. */
export class AppException extends HttpException {
  constructor(public readonly appError: AppError) {
    super(appError.message, HTTP_STATUS_BY_CODE[appError.code]);
  }
}

/** Unwraps a Result at the controller edge. */
export const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new AppException(result.error);
  return result.value;
};
