import { HttpException, HttpStatus } from '@nestjs/common';

/** Body of every error response. `message` is always a single string (the mobile client relies on it). */
export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Domain error with a stable machine-readable `code`.
 * Throw it from services; AllExceptionsFilter turns it into an ErrorBody.
 */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(
      { statusCode: status, code, message, details } satisfies ErrorBody,
      status,
    );
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new AppError(HttpStatus.BAD_REQUEST, code, message, details);
  }

  static unauthorized(code: string, message: string) {
    return new AppError(HttpStatus.UNAUTHORIZED, code, message);
  }

  static forbidden(
    message = 'You do not have permission to perform this action',
  ) {
    return new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);
  }

  static notFound(resource: string) {
    return new AppError(
      HttpStatus.NOT_FOUND,
      'NOT_FOUND',
      `${resource} not found`,
    );
  }

  static conflict(code: string, message: string, details?: unknown) {
    return new AppError(HttpStatus.CONFLICT, code, message, details);
  }
}
