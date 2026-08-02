import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { RequestContext, RequestContextStore } from './request-context';

/**
 * Opens the AsyncLocalStorage scope for the lifetime of the request.
 *
 * This has to be middleware rather than an interceptor. An interceptor returns
 * an Observable, and Nest does not subscribe to it until after the interceptor
 * has returned — so `AsyncLocalStorage.run()` would have already exited by the
 * time the route handler executes, leaving the store empty exactly where it is
 * needed.
 *
 * Middleware calls `next()` *inside* the scope, so everything downstream —
 * guards, interceptors, the handler, the repositories — runs within it.
 *
 * The object is seeded empty and filled in by JwtAuthGuard once the caller is
 * authenticated. Storing a mutable reference is what lets a component that
 * runs later populate a scope that was opened earlier.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request & { requestId?: string }, _res: Response, next: NextFunction): void {
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    req.requestId = requestId;

    const context: RequestContext = {
      userId: '',
      organizationId: '',
      roleKey: '',
      permissions: [],
      requestId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };

    RequestContextStore.run(context, () => next());
  }
}
