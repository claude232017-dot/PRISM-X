import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { NodeSecurityService, VerifiedNodeCaller } from './node-security.service';
import { RequestContextStore } from '../shared/context/request-context';

export interface NodeAgentRequest extends Request {
  nodeCaller?: VerifiedNodeCaller;
}

/**
 * Authenticates a peer node instead of a user.
 *
 * Agent endpoints are reached by machines, not people, so the usual JWT path
 * does not apply — there is no session, no membership and no role. What
 * there is instead is a signature, and verifying it establishes both who is
 * calling and which organization's data they may touch.
 *
 * The organization comes out of the *key*, never out of the request body. A
 * node cannot name the tenant it wants to act on; it can only prove which
 * one it belongs to.
 */
@Injectable()
export class NodeAgentGuard implements CanActivate {
  private readonly logger = new Logger(NodeAgentGuard.name);

  constructor(private readonly security: NodeSecurityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<NodeAgentRequest>();

    // The signature covers the exact bytes that were sent. Re-serializing
    // the parsed body would let a difference in key order or whitespace
    // fail a request that is genuinely correct, so the raw body is used
    // where the middleware captured it.
    const raw = (request as unknown as { rawBody?: Buffer }).rawBody;
    const body = raw ? raw.toString('utf8') : JSON.stringify(request.body ?? {});

    const caller = await this.security.verifyRequest({
      nodeId: request.header('x-prismx-node-id') ?? undefined,
      keyVersion: request.header('x-prismx-key-version') ?? undefined,
      timestamp: request.header('x-prismx-timestamp') ?? undefined,
      signature: request.header('x-prismx-signature') ?? undefined,
      body,
    });

    request.nodeCaller = caller;

    // The middleware opened a context before authentication ran; the tenant
    // that verification just established is written into it so repositories
    // downstream scope to the right organization.
    const ctx = RequestContextStore.get();
    if (ctx) {
      ctx.organizationId = caller.organizationId;
      ctx.userId = `node:${caller.nodeId}`;
      ctx.roleKey = 'NODE';
      ctx.permissions = ['node:execute'];
    }

    return true;
  }
}
