import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '../permissions';
import type { AuthenticatedPrincipal } from '../auth.service';

export const PERMISSIONS_KEY = 'required_permissions';
export const IS_PUBLIC_KEY = 'is_public_route';

/**
 * Declares the permissions a handler requires. PermissionsGuard reads this;
 * a handler with no decorator still requires authentication, just no specific
 * capability.
 */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Opts a route out of authentication entirely (login, register, health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Injects the authenticated principal, or one of its fields. */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedPrincipal | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthenticatedPrincipal | undefined;
    return field && user ? user[field] : user;
  },
);

/** Injects the caller's organization id. */
export const CurrentOrg = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return (request.user as AuthenticatedPrincipal | undefined)?.organizationId;
});
