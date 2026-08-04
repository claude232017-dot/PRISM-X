import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditLogRepository } from '../../database/repositories/tenant.repositories';
import { RequestContextStore } from '../context/request-context';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Writes an audit row for every successful state-changing request.
 *
 * Reads are skipped deliberately: logging every GET would bury the entries
 * that matter under noise and multiply write load for no compliance benefit.
 * Failures are not audited here either — those surface through the exception
 * filter's logs.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly auditLogs: AuditLogRepository) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();

    if (!MUTATING.has(request.method) || !request.user) {
      return next.handle();
    }

    return next.handle().pipe(
      tap((result) => {
        void this.record(request, context, result);
      }),
    );
  }

  private async record(
    request: {
      method: string;
      route?: { path?: string };
      url: string;
      params?: Record<string, string>;
      ip?: string;
      headers?: Record<string, unknown>;
    },
    context: ExecutionContext,
    result: unknown,
  ): Promise<void> {
    const ctx = RequestContextStore.get();
    if (!ctx) return;

    const resource = context.getClass().name.replace(/Controller$/, '').toLowerCase();
    const resourceId =
      request.params?.id ??
      (result && typeof result === 'object' && 'id' in result
        ? String((result as { id: unknown }).id)
        : undefined);

    try {
      // Buffered, not written one row at a time: this runs on every mutating
      // request, and the read path drains before querying so nothing is
      // invisible for having been batched.
      await this.auditLogs.append({
        userId: ctx.userId,
        action: `${request.method} ${request.route?.path ?? request.url}`,
        resource,
        resourceId: resourceId ?? null,
        ip: request.ip ?? null,
        userAgent: (request.headers?.['user-agent'] as string) ?? null,
        metadata: { requestId: ctx.requestId } as never,
      });
    } catch (error) {
      // Never fail the request because the audit write failed.
      this.logger.error(`Audit write failed: ${(error as Error).message}`);
    }
  }
}
