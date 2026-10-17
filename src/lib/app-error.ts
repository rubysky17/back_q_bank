import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Body of every error response. `message` is always a single string (the mobile client relies on it). */
export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Domain error with a stable machine-readable `code`.
 * Throw it from services; the app's error handler turns it into an ErrorBody.
 */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toBody(): ErrorBody {
    const body: ErrorBody = {
      statusCode: this.status,
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new AppError(400, code, message, details);
  }

  static unauthorized(code: string, message: string) {
    return new AppError(401, code, message);
  }

  static forbidden(
    message = 'You do not have permission to perform this action',
  ) {
    return new AppError(403, 'FORBIDDEN', message);
  }

  static notFound(resource: string) {
    return new AppError(404, 'NOT_FOUND', `${resource} not found`);
  }

  static conflict(code: string, message: string, details?: unknown) {
    return new AppError(409, code, message, details);
  }

  static tooManyRequests() {
    return new AppError(
      429,
      'TOO_MANY_REQUESTS',
      'Too many requests, please try again later',
    );
  }
}
