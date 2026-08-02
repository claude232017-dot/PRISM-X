import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The authenticated caller, propagated implicitly down the call stack.
 *
 * This exists so the repository layer can enforce organization scoping
 * without every service method having to thread an `orgId` parameter through
 * by hand — a pattern that fails open the moment someone forgets an argument.
 * Here, forgetting means there is no context at all, and the repository
 * throws. It fails closed.
 */
export interface RequestContext {
  userId: string;
  organizationId: string;
  roleKey: string;
  permissions: string[];
  requestId: string;
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContextStore = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },

  /** Returns the active context, or `undefined` for unauthenticated/system paths. */
  get(): RequestContext | undefined {
    return storage.getStore();
  },

  /**
   * Returns the active context or throws — use where a tenant is mandatory.
   *
   * An empty `organizationId` counts as absent: the middleware seeds the scope
   * before authentication runs, so a populated store is not by itself proof
   * that a tenant was resolved.
   */
  require(): RequestContext {
    const ctx = storage.getStore();
    if (!ctx || !ctx.organizationId) {
      throw new Error(
        'No RequestContext available. A tenant-scoped operation ran outside an ' +
          'authenticated request. Use AuthService.asSystem() for background jobs.',
      );
    }
    return ctx;
  },
};
