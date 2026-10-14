import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import { Prisma } from '../../generated/prisma/client.js';
import { AppError, type ErrorBody } from '../errors/app-error.js';

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
};

const DEFAULT_MESSAGES: Record<number, string> = {
  429: 'Too many requests, please try again later',
};

/** Normalises every error into `{ statusCode, code, message, details? }`. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const body = this.toBody(exception);
    if (body.statusCode >= 500) {
      this.logger.error(
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : exception,
      );
    }
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(body.statusCode)
      .json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof AppError) {
      return exception.getResponse() as ErrorBody;
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      return {
        statusCode,
        code: DEFAULT_CODES[statusCode] ?? 'HTTP_ERROR',
        message:
          DEFAULT_MESSAGES[statusCode] ??
          readMessage(exception.getResponse()) ??
          exception.message,
      };
    }

    // Errors raised by Express middleware before Nest (e.g. malformed JSON body).
    const status = readStatus(exception);
    if (status !== undefined && status >= 400 && status < 500) {
      return {
        statusCode: status,
        code: DEFAULT_CODES[status] ?? 'BAD_REQUEST',
        message: isBodyParseError(exception)
          ? 'Request body is not valid JSON'
          : (readMessage(exception) ?? 'Bad request'),
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };
  }

  private fromPrisma(error: Prisma.PrismaClientKnownRequestError): ErrorBody {
    switch (error.code) {
      case 'P2002':
        return {
          statusCode: HttpStatus.CONFLICT,
          code: 'ALREADY_EXISTS',
          message: 'A record with the same unique value already exists',
        };
      case 'P2003':
        return {
          statusCode: HttpStatus.CONFLICT,
          code: 'RESOURCE_IN_USE',
          message: 'The record is referenced by other records',
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'Record not found',
        };
      default:
        this.logger.error(
          `Unhandled Prisma error ${error.code}: ${error.message}`,
        );
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        };
    }
  }
}

function readMessage(response: unknown): string | undefined {
  if (typeof response === 'string') return response;
  if (typeof response !== 'object' || response === null) return undefined;
  const { message } = response as { message?: unknown };
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return undefined;
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, statusCode } = error as {
    status?: unknown;
    statusCode?: unknown;
  };
  if (typeof status === 'number') return status;
  if (typeof statusCode === 'number') return statusCode;
  return undefined;
}

function isBodyParseError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'entity.parse.failed'
  );
}
