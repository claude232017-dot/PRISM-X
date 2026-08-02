import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  requestId?: string;
  timestamp: string;
}

/**
 * Single exit point for every error leaving the API.
 *
 * Two jobs: translate Prisma's error codes into meaningful HTTP status codes
 * (a duplicate slug is a 409, not a 500), and make sure an unexpected error
 * never leaks a stack trace or SQL fragment to the client while still being
 * fully logged server-side.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();

    const { status, error, message } = this.translate(exception);

    const body: ErrorBody = {
      statusCode: status,
      error,
      message,
      path: request.url,
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}: ${
          exception instanceof Error ? exception.stack : String(exception)
        }`,
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${status}: ${String(message)}`);
    }

    response.status(status).json(body);
  }

  private translate(exception: unknown): {
    status: number;
    error: string;
    message: string | string[];
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);
      return { status, error: HttpStatus[status] ?? 'Error', message };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            error: 'Conflict',
            message: `A record with that ${this.targetOf(exception)} already exists`,
          };
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            error: 'Not Found',
            message: 'The requested record does not exist',
          };
        case 'P2003':
          return {
            status: HttpStatus.BAD_REQUEST,
            error: 'Bad Request',
            message: 'Referenced record does not exist',
          };
        default:
          break;
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: 'The request did not match the expected shape',
      };
    }

    // Missing RequestContext means a tenant-scoped path ran unauthenticated —
    // a bug, but the safe answer to the caller is "forbidden", not a 500 that
    // discloses internals.
    if (exception instanceof Error && exception.message.includes('No RequestContext')) {
      return {
        status: HttpStatus.FORBIDDEN,
        error: 'Forbidden',
        message: 'This operation requires an authenticated organization context',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    };
  }

  private targetOf(error: Prisma.PrismaClientKnownRequestError): string {
    const target = (error.meta as { target?: string[] } | undefined)?.target;
    return Array.isArray(target) ? target.join(', ') : 'value';
  }
}
