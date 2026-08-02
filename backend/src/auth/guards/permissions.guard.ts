import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
} from '../decorators/permissions.decorator';
import type { PermissionKey } from '../permissions';
import type { AuthenticatedPrincipal } from '../auth.service';

/**
 * Enforces `@RequirePermissions(...)`.
 *
 * All listed permissions must be held (AND, not OR) — a handler that both
 * reads and writes should be reachable only by a caller who can do both.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const user = context.switchToHttp().getRequest()
      .user as AuthenticatedPrincipal | undefined;
    if (!user) throw new ForbiddenException('Not authenticated');

    // '*' is granted only to internal/system callers, never to a real role.
    if (user.permissions.includes('*')) return true;

    const missing = required.filter((p) => !user.permissions.includes(p));
    if (missing.length) {
      throw new ForbiddenException(
        `Your role (${user.roleKey}) is missing: ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
