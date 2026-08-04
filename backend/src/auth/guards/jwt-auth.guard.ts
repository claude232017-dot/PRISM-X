import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../auth.service';
import { IS_PUBLIC_KEY } from '../decorators/permissions.decorator';
import { RequestContextStore } from '../../shared/context/request-context';

/**
 * Authenticates the bearer token and opens the RequestContext for the rest of
 * the request.
 *
 * Registered globally, so every route is protected unless explicitly marked
 * `@Public()`. Defaulting to "locked" means a new controller cannot ship
 * unauthenticated because someone forgot a decorator.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = JwtAuthGuard.extractToken(request.headers?.authorization);
    const apiKey = request.headers?.['x-api-key'] as string | undefined;

    if (!token && !apiKey) {
      throw new UnauthorizedException('Missing bearer token');
    }

    // An API key is the public API's credential. It authenticates to an
    // organization rather than to a person, and carries only its own scopes —
    // so a key cannot reach anything the person who issued it did not grant.
    // Bearer wins when both are present: a human's session is the more
    // specific claim, and silently preferring a key would let a stale header
    // downgrade an authenticated request.
    const principal = token
      ? await this.auth.authenticate(
          token,
          // Lets a user who belongs to several organizations choose which one
          // this request acts within; defaults to their first active membership.
          request.headers?.['x-organization-id'] as string | undefined,
        )
      : await this.auth.authenticateApiKey(apiKey!);

    request.user = principal;
    request.accessToken = token;

    // RequestContextMiddleware already opened the scope; fill it in place.
    // Mutating the stored object (rather than calling `run` again here) is
    // what makes the tenant visible to code that executes after this guard.
    const requestContext = RequestContextStore.get();
    if (requestContext) {
      requestContext.userId = principal.userId;
      requestContext.organizationId = principal.organizationId;
      requestContext.roleKey = principal.roleKey;
      requestContext.permissions = principal.permissions;
    }

    return true;
  }

  private static extractToken(header?: string): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
