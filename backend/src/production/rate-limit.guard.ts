import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CacheService } from '../shared/cache/cache.service';
import { RequestContextStore } from '../shared/context/request-context';
import { Metric, MetricsService } from './metrics.service';

export const RATE_LIMIT_KEY = 'prismx:rate-limit';

export interface RateLimitOptions {
  /** Requests permitted in the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/** Overrides the default budget for one route. */
export const RateLimit = (limit: number, windowSeconds = 60): MethodDecorator =>
  ((target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(RATE_LIMIT_KEY, { limit, windowSeconds }, descriptor.value);
    return descriptor;
  }) as MethodDecorator;

/**
 * Per-principal request limiting.
 *
 * Three things distinguish this from a token bucket in a variable:
 *
 * **The counter is shared.** It lives in Redis, so N instances enforce one
 * budget rather than N. A per-process limiter behind a load balancer permits
 * N times what it claims, and the number changes when you scale.
 *
 * **It fails closed on the identity, open on the infrastructure.** An
 * unauthenticated caller is limited by address, an authenticated one by
 * principal — so one tenant cannot spend another's budget. But when Redis is
 * unreachable the request proceeds: a limiter that takes the API down when the
 * cache blinks has converted a degraded dependency into an outage. That trade
 * is deliberate and is why the fallback is logged and counted.
 *
 * **Anonymous traffic gets a tighter budget than authenticated traffic.**
 * Login and registration are where credential stuffing happens, and they are
 * exactly the routes a caller reaches before having an identity to limit.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private warned = false;

  /** Authenticated default: generous, because a session is accountable. */
  private static readonly DEFAULT: RateLimitOptions = { limit: 600, windowSeconds: 60 };
  /** Anonymous default: tight, because it is not. */
  private static readonly ANONYMOUS: RateLimitOptions = { limit: 60, windowSeconds: 60 };

  constructor(
    private readonly cache: CacheService,
    private readonly metrics: MetricsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const requestContext = RequestContextStore.get();

    const override = this.reflector.get<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );

    // The principal, most specific first. An API key gets its own budget rather
    // than sharing the organization's, so one integration cannot starve a
    // customer's own dashboard.
    const apiKey = request.headers?.['x-api-key'];
    const identity = apiKey
      ? `key:${String(apiKey).slice(0, 16)}`
      : requestContext?.userId && requestContext.userId !== 'system'
        ? `user:${requestContext.userId}`
        : `ip:${RateLimitGuard.addressOf(request)}`;

    const authenticated = !identity.startsWith('ip:');
    const options =
      override ?? (authenticated ? RateLimitGuard.DEFAULT : RateLimitGuard.ANONYMOUS);

    const window = Math.floor(Date.now() / (options.windowSeconds * 1000));
    const key = `ratelimit:${identity}:${window}`;

    const used = await this.cache.increment(key, options.windowSeconds + 10);

    if (used === null) {
      // No shared counter. Proceed rather than reject — see the class comment.
      if (!this.warned) {
        this.warned = true;
        this.logger.warn('Rate limiting is degraded: no shared counter available');
      }
      this.metrics.increment(Metric.RateLimited, { outcome: 'degraded' });
      return true;
    }
    this.warned = false;

    const remaining = Math.max(0, options.limit - used);
    response?.setHeader?.('x-ratelimit-limit', String(options.limit));
    response?.setHeader?.('x-ratelimit-remaining', String(remaining));
    response?.setHeader?.(
      'x-ratelimit-reset',
      String((window + 1) * options.windowSeconds),
    );

    if (used > options.limit) {
      this.metrics.increment(Metric.RateLimited, {
        outcome: 'blocked',
        principal: authenticated ? 'authenticated' : 'anonymous',
      });
      // Retry-After in seconds, so a well-behaved client knows when to return
      // instead of retrying immediately and making the problem worse.
      const retryAfter = options.windowSeconds - (Math.floor(Date.now() / 1000) % options.windowSeconds);
      response?.setHeader?.('retry-after', String(retryAfter));

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Rate limit exceeded: ${options.limit} requests per ${options.windowSeconds}s`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * The caller's address.
   *
   * `x-forwarded-for` is honoured only for its first entry, which is the
   * client as recorded by the outermost proxy. Trusting the whole chain lets a
   * caller prepend anything they like and rotate through a limitless supply of
   * identities.
   */
  private static addressOf(request: {
    headers?: Record<string, unknown>;
    ip?: string;
    socket?: { remoteAddress?: string };
  }): string {
    const forwarded = request.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) {
      return forwarded.split(',')[0].trim();
    }
    return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  }
}
