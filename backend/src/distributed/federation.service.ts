import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FederationGrant, Node } from '@prisma/client';
import {
  FederationGrantRepository,
  NodeRepository,
} from '../database/repositories/distributed.repositories';
import { OrganizationRepository } from '../database/repositories/identity.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';

/** The complete set of things one organization can lend another. */
export const FEDERATION_RESOURCES = [
  'nodes:execute',
  'nodes:read',
  'memory:read',
  'memory:write',
  'knowledge:read',
  'workers:invoke',
] as const;

export type FederationResource = (typeof FEDERATION_RESOURCES)[number];

export interface IssueGrantInput {
  peerOrganizationId: string;
  resources: string[];
  name?: string;
  allowedNodeIds?: string[];
  maxConcurrentTasks?: number;
  expiresAt?: Date | null;
  terms?: Record<string, unknown>;
}

export interface FederationCheck {
  allowed: boolean;
  reason: string;
  grant?: FederationGrant;
}

/**
 * Sharing between organizations, and nothing else.
 *
 * The governing rule is that there is no ambient trust anywhere: two
 * organizations that have not exchanged a grant are, to each other,
 * strangers with no more access than the public internet has. Everything
 * shared is named explicitly, bounded explicitly, and revocable at any
 * moment by the side that owns it.
 *
 * Grants are one-directional on purpose. Mutual sharing is two grants, which
 * costs one extra call and buys the guarantee that accepting help never
 * silently obliges you to give any.
 */
@Injectable()
export class FederationService {
  private readonly logger = new Logger(FederationService.name);

  constructor(
    private readonly grants: FederationGrantRepository,
    private readonly nodes: NodeRepository,
    private readonly organizations: OrganizationRepository,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  /**
   * Offers a peer access to named resources.
   *
   * A grant starts PENDING and confers nothing. Access begins only when the
   * peer accepts, so an organization cannot be enrolled into a federation it
   * did not agree to — being given access is still a decision on both sides.
   */
  async issue(input: IssueGrantInput): Promise<FederationGrant> {
    const ctx = RequestContextStore.require();

    if (input.peerOrganizationId === ctx.organizationId) {
      throw new BadRequestException('An organization cannot federate with itself');
    }

    // OrganizationRepository is an identity repository and is deliberately
    // not tenant-scoped — resolving a peer by id is the one lookup that has
    // to see outside the current organization.
    const peer = await this.organizations.findById(input.peerOrganizationId);
    if (!peer) throw new NotFoundException('That organization does not exist');

    const unknown = input.resources.filter(
      (r) => !FEDERATION_RESOURCES.includes(r as FederationResource),
    );
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown federation resource(s): ${unknown.join(', ')}. ` +
          `Valid values: ${FEDERATION_RESOURCES.join(', ')}`,
      );
    }
    if (input.resources.length === 0) {
      throw new BadRequestException(
        'A grant with no resources shares nothing. Name what is being shared.',
      );
    }

    const existing = await this.grants.findMany({
      peerOrganizationId: input.peerOrganizationId,
    });
    if (existing.length > 0) {
      throw new BadRequestException(
        'A grant to that organization already exists. Amend or revoke it instead.',
      );
    }

    const grant = await this.grants.create({
      peerOrganizationId: input.peerOrganizationId,
      name: input.name ?? `Grant to ${peer.name}`,
      resources: input.resources,
      allowedNodeIds: input.allowedNodeIds ?? [],
      maxConcurrentTasks: input.maxConcurrentTasks ?? 1,
      expiresAt: input.expiresAt ?? null,
      status: 'PENDING',
      createdById: ctx.userId,
      terms: (input.terms ?? {}) as never,
    });

    await this.events.publish(DomainEvent.FederationGranted, {
      grantId: grant.id,
      peerOrganizationId: input.peerOrganizationId,
      resources: input.resources,
    });

    return grant;
  }

  /** Accepted by the *receiving* organization. Only then does access begin. */
  async accept(grantId: string): Promise<FederationGrant> {
    const ctx = RequestContextStore.require();
    const grant = await this.grants.findByIdUnscopedForPeer(grantId, ctx.organizationId);

    if (!grant) {
      throw new NotFoundException('No grant to this organization with that id');
    }
    if (grant.status !== 'PENDING') {
      throw new BadRequestException(`That grant is already ${grant.status}`);
    }

    const accepted = await this.grants.acceptAsPeer(grantId, ctx.organizationId);

    await this.events.publish(
      DomainEvent.FederationAccepted,
      { grantId, peerOrganizationId: ctx.organizationId },
      { organizationId: grant.organizationId },
    );

    return accepted;
  }

  /**
   * Withdraws access.
   *
   * Either side may revoke: the owner because it no longer wishes to share,
   * the peer because it no longer wishes to be entangled. Revocation takes
   * effect immediately rather than at the end of borrowed work, because a
   * revocation you have to wait out is not a revocation.
   */
  async revoke(grantId: string): Promise<FederationGrant> {
    const ctx = RequestContextStore.require();
    const grant = await this.grants.findEitherSide(grantId, ctx.organizationId);
    if (!grant) throw new NotFoundException('No such grant');

    const revoked = await this.grants.revokeEitherSide(grantId, ctx.userId);

    await this.events.publish(
      DomainEvent.FederationRevoked,
      { grantId, revokedBy: ctx.organizationId },
      { organizationId: grant.organizationId },
    );

    return revoked;
  }

  async listIssued(): Promise<FederationGrant[]> {
    return this.grants.issued();
  }

  async listReceived(): Promise<FederationGrant[]> {
    return this.grants.received();
  }

  // ----------------------------------------------------------------
  // Authorisation
  // ----------------------------------------------------------------

  /**
   * The single question the rest of the system asks federation.
   *
   * Written to return a reason rather than a bare boolean because a denied
   * cross-organization request is exactly the kind of thing an operator
   * needs explained — "no grant" and "grant expired" call for very
   * different responses.
   */
  async check(ownerOrganizationId: string, resource: string): Promise<FederationCheck> {
    const ctx = RequestContextStore.require();

    if (ownerOrganizationId === ctx.organizationId) {
      return { allowed: true, reason: 'same organization' };
    }

    const grant = await this.grants.findUsableUnscoped(ownerOrganizationId, ctx.organizationId);

    if (!grant) {
      return {
        allowed: false,
        reason: 'no active grant from that organization — nothing is shared by default',
      };
    }
    if (!grant.resources.includes(resource)) {
      return {
        allowed: false,
        reason: `grant does not include "${resource}" (it covers ${grant.resources.join(', ')})`,
        grant,
      };
    }
    if (grant.activeTasks >= grant.maxConcurrentTasks) {
      return {
        allowed: false,
        reason: `grant is at its concurrency limit (${grant.maxConcurrentTasks})`,
        grant,
      };
    }

    return { allowed: true, reason: 'granted', grant };
  }

  /** `check` as a guard. Records the denial, since that is the interesting case. */
  async assert(ownerOrganizationId: string, resource: string): Promise<FederationGrant | null> {
    const result = await this.check(ownerOrganizationId, resource);

    if (!result.allowed) {
      await this.events.publish(DomainEvent.FederationAccessDenied, {
        ownerOrganizationId,
        resource,
        reason: result.reason,
      });
      throw new ForbiddenException(`Federation denied: ${result.reason}`);
    }

    return result.grant ?? null;
  }

  /**
   * Nodes a peer has made available to us.
   *
   * Filtered twice — by the grant's node allow-list and by the node's own
   * willingness to take remote work — because a grant naming a node does not
   * override that node being drained or untrusted by its own organization.
   */
  async borrowableNodes(ownerOrganizationId: string): Promise<Node[]> {
    const grant = await this.assert(ownerOrganizationId, 'nodes:execute');
    if (!grant) return [];

    const pool = await this.nodes.findSchedulableForOrganizationUnscoped(ownerOrganizationId);

    return grant.allowedNodeIds.length > 0
      ? pool.filter((node) => grant.allowedNodeIds.includes(node.id))
      : pool;
  }

  /** Reserves a slot against a grant's concurrency ceiling. */
  async beginBorrowed(grantId: string, taskId: string): Promise<void> {
    await this.grants.adjustActive(grantId, 1);
    await this.events.publish(DomainEvent.FederationTaskBorrowed, { grantId, taskId });
  }

  async endBorrowed(grantId: string): Promise<void> {
    await this.grants.adjustActive(grantId, -1);
  }
}
