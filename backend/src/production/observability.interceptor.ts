import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RequestContextStore } from '../shared/context/request-context';
import { InstanceService } from './instance.service';
import { Metric, MetricsService } from './metrics.service';

/**
 * Records what every request did, and gives it a thread to be followed by.
 *
 * Two jobs, both cheap and both worth doing on the hot path:
 *
 * **Metrics.** Count, error count and duration, labelled by method, route and
 * status class. The route is the *template* — `/missions/:id`, not
 * `/missions/clx0abc` — because a label with an unbounded value set is a
 * memory leak with a dashboard attached.
 *
 * **Correlation.** The request id already exists in `RequestContext`; this
 * echoes it back as `x-request-id` so a caller reporting a problem can quote
 * the one string that finds every log line, every job and every event the
 * request produced. Across several instances that identifier is the only thing
 * that turns interleaved logs back into a story.
 *
 * An inbound `x-request-id` is honoured rather than replaced, so a trace that
 * started at the gateway keeps its identity through this service.
 */
@Injectable()
export class ObservabilityInterceptor implements NestInterceptor {
  constructor(
    private readonly metrics: MetricsService,
    private readonly instances: InstanceService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const started = Date.now();

    const requestContext = RequestContextStore.get();
    const inbound = request.headers?.['x-request-id'];
    const requestId =
      (typeof inbound === 'string' && inbound.slice(0, 200)) ||
      requestContext?.requestId ||
      'unknown';

    if (requestContext && typeof inbound === 'string' && inbound) {
      // Adopt the caller's identifier so one trace spans both systems.
      requestContext.requestId = requestId;
    }
    response?.setHeader?.('x-request-id', requestId);
    response?.setHeader?.('x-instance-id', this.instances.instanceId);

    const route = ObservabilityInterceptor.routeOf(context, request);
    const method = String(request.method ?? 'GET');
    this.instances.requestStarted();

    const record = (statusCode: number): void => {
      const duration = Date.now() - started;
      const status = `${Math.floor(statusCode / 100)}xx`;
      const labels = { method, route, status };

      this.metrics.increment(Metric.HttpRequests, labels, 1, 'HTTP requests handled');
      this.metrics.observe(Metric.HttpDuration, duration, { method, route }, 'HTTP request duration in milliseconds');
      if (statusCode >= 500) {
        this.metrics.increment(Metric.HttpErrors, labels, 1, 'HTTP responses that failed');
      }
      this.instances.requestFinished();
    };

    return next.handle().pipe(
      tap({
        next: () => record(response?.statusCode ?? 200),
        // A thrown exception has not reached the filter yet, so the response
        // status is still the default. The error's own status is the truth.
        error: (error: { status?: number; statusCode?: number }) =>
          record(error?.status ?? error?.statusCode ?? 500),
      }),
    );
  }

  /**
   * The route template, falling back to a path with identifiers masked.
   *
   * Nest exposes the matched route on the Express request; when it does not —
   * a 404, a non-Express adapter — the path is collapsed by replacing anything
   * that looks like an identifier. Either way the label set stays bounded.
   */
  private static routeOf(context: ExecutionContext, request: { route?: { path?: string }; url?: string }): string {
    const template = request.route?.path;
    if (template) return template;

    const path = String(request.url ?? '/').split('?')[0];
    return path
      .split('/')
      .map((segment) =>
        /^[0-9a-f]{8,}$/i.test(segment) || /^\d+$/.test(segment) || /^c[a-z0-9]{20,}$/i.test(segment)
          ? ':id'
          : segment,
      )
      .join('/');
  }
}
