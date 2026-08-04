import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { AUTH_PROVIDER, IAuthProvider } from './providers/auth-provider.interface';
import {
  MembershipRepository,
  OrganizationRepository,
  RoleRepository,
  UserRepository,
} from '../database/repositories/identity.repositories';
import { PrismaService } from '../database/prisma.service';
import { CacheService } from '../shared/cache/cache.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import type { DomainEventEnvelope } from '../events/domain-events';
import { SystemRole } from './permissions';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { RequestContextStore } from '../shared/context/request-context';

/** What an API key resolves to. Mirrors `ResolvedApiKey` without importing it. */
export interface ResolvedApiKeyPrincipal {
  apiKeyId: string;
  organizationId: string;
  scopes: string[];
  rateLimitPerMinute: number;
}

export interface AuthenticatedPrincipal {
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  roleKey: string;
  permissions: string[];
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  /**
   * How long a resolved permission set is trusted without re-reading it.
   *
   * This is the window in which a revoked role still works. Explicit
   * invalidation closes it immediately for every change the platform knows
   * about; the TTL only bounds the ones it does not.
   */
  private static readonly ACCESS_CACHE_TTL = AuthService.cacheTtl();

  private static cacheTtl(): number {
    const configured = Number.parseInt(process.env.ACCESS_CACHE_TTL_SECONDS ?? '', 10);
    if (!Number.isFinite(configured) || configured < 0) return 60;
    // Capped: a deployment may trade freshness for load, but not unboundedly.
    return Math.min(configured, 300);
  }

  constructor(
    @Inject(AUTH_PROVIDER) private readonly provider: IAuthProvider,
    private readonly users: UserRepository,
    private readonly organizations: OrganizationRepository,
    private readonly memberships: MembershipRepository,
    private readonly roles: RoleRepository,
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly events: EventBusService,
  ) {}

  /**
   * Registers an identity and provisions its first organization.
   *
   * The local rows (user + org + owner membership) are written in one
   * transaction: a half-created account with no organization would leave the
   * user permanently unable to do anything.
   */
  async register(dto: RegisterDto) {
    const identity = await this.provider.register({
      email: dto.email,
      password: dto.password,
      displayName: dto.displayName,
    });

    const ownerRole = await this.roles.findByKey(SystemRole.Owner, null);
    if (!ownerRole) {
      throw new Error('System roles are not seeded — run `npm run db:seed`.');
    }

    const { user, organization } = await this.prisma.transaction(async (tx) => {
      const existing = await this.users.findByEmail(identity.email, tx);
      const user =
        existing ??
        (await this.users.create(
          {
            email: identity.email,
            displayName: identity.displayName ?? dto.displayName ?? null,
            supabaseUserId: identity.externalId,
            emailVerified: identity.emailVerified,
          },
          tx,
        ));

      const organization = await this.organizations.create(
        {
          name: dto.organizationName ?? `${identity.email.split('@')[0]}'s workspace`,
          slug: await this.uniqueSlug(dto.organizationName ?? identity.email.split('@')[0], tx),
        },
        tx,
      );

      await this.memberships.create(
        {
          userId: user.id,
          organizationId: organization.id,
          roleId: ownerRole.id,
          status: 'ACTIVE',
          joinedAt: new Date(),
        },
        tx,
      );

      return { user, organization };
    });

    // Publishing needs a tenant in context; registration runs unauthenticated,
    // so the org is supplied explicitly.
    await this.events.publish(
      DomainEvent.OrganizationCreated,
      { organizationId: organization.id, name: organization.name },
      { organizationId: organization.id, actorId: user.id },
    );
    await this.events.publish(
      DomainEvent.UserRegistered,
      { userId: user.id, email: user.email },
      { organizationId: organization.id, actorId: user.id },
    );

    const { tokens } = await this.provider.login({
      email: dto.email,
      password: dto.password,
    });

    return {
      ...tokens,
      user: { id: user.id, email: user.email, displayName: user.displayName },
      organization: { id: organization.id, name: organization.name, slug: organization.slug },
    };
  }

  async login(dto: LoginDto) {
    const { identity, tokens } = await this.provider.login({
      email: dto.email,
      password: dto.password,
    });

    const user = await this.resolveLocalUser(identity.email, identity.externalId);
    const access = await this.resolveAccess(user.id, dto.organizationId);

    await this.users.markLogin(user.id);
    await this.events.publish(
      DomainEvent.UserLoggedIn,
      { userId: user.id },
      { organizationId: access.organizationId, actorId: user.id },
    );

    return {
      ...tokens,
      user: { id: user.id, email: user.email, displayName: user.displayName },
      organization: { id: access.organizationId, name: access.organizationName },
      role: access.roleKey,
      permissions: access.permissions,
    };
  }

  async logout(accessToken: string, userId?: string): Promise<{ success: true }> {
    await this.provider.logout(accessToken);
    if (userId) await this.cache.deleteByPrefix(`access:${userId}`);
    return { success: true };
  }

  async refresh(refreshToken: string) {
    return this.provider.refresh(refreshToken);
  }

  async requestPasswordReset(email: string): Promise<{ success: true }> {
    await this.provider.requestPasswordReset(email);
    // Deliberately identical response whether or not the account exists.
    return { success: true };
  }

  async resetPassword(token: string, newPassword: string): Promise<{ success: true }> {
    await this.provider.resetPassword(token, newPassword);
    return { success: true };
  }

  async sendVerificationEmail(email: string): Promise<{ success: true }> {
    await this.provider.sendVerificationEmail(email);
    return { success: true };
  }

  /**
   * Called by the JWT strategy on every request: verifies the token with the
   * active provider, then resolves the caller's org membership and permissions.
   */
  /**
   * Resolver for API-key authentication, installed by `ApiKeyService`.
   *
   * A callback rather than an injected dependency: key management lives in the
   * automation module, which already depends on auth, and a second edge back
   * would be a cycle. The same seam pattern the approvals, notification and
   * node-routing paths use.
   */
  private apiKeyResolver?: (presented: string) => Promise<ResolvedApiKeyPrincipal>;

  onApiKeyResolver(
    resolver: (presented: string) => Promise<ResolvedApiKeyPrincipal>,
  ): void {
    this.apiKeyResolver = resolver;
  }

  /**
   * Authenticates a programmatic caller presenting an API key.
   *
   * The key's scopes *are* its permissions — an API key is a subset of what
   * the organization can do, never a superset, and a key issued with no scopes
   * can therefore read nothing rather than everything. That is the same
   * intersection rule the platform applies to extension capabilities, and it
   * matters more here: an API key travels outside the product.
   */
  async authenticateApiKey(presented: string): Promise<AuthenticatedPrincipal> {
    if (!this.apiKeyResolver) {
      throw new UnauthorizedException('API key authentication is unavailable');
    }
    const resolved = await this.apiKeyResolver(presented);
    const organization = await this.organizations.findById(resolved.organizationId);

    return {
      // Not a real user, and deliberately shaped so it can never collide with
      // one: audit rows attribute the action to the key that performed it.
      userId: `apikey:${resolved.apiKeyId}`,
      email: `apikey:${resolved.apiKeyId}`,
      organizationId: resolved.organizationId,
      organizationName: organization?.name ?? 'unknown',
      roleKey: 'API_KEY',
      permissions: resolved.scopes,
    };
  }

  async authenticate(accessToken: string, organizationId?: string): Promise<AuthenticatedPrincipal> {
    const verified = await this.provider.verify(accessToken);
    const user = await this.resolveLocalUser(verified.email, verified.externalId);
    const access = await this.resolveAccess(user.id, organizationId);

    return {
      userId: user.id,
      email: user.email,
      organizationId: access.organizationId,
      organizationName: access.organizationName,
      roleKey: access.roleKey,
      permissions: access.permissions,
    };
  }

  /**
   * Membership + permission lookup, cached briefly in Redis.
   *
   * The cache is shared rather than per-process, so an explicit invalidation
   * takes effect on every instance at once. The TTL is the backstop for
   * anything that changes authorization *without* announcing it — and a
   * backstop measured in minutes is a revoked administrator who still has
   * administrator rights for those minutes, which is why it is a minute rather
   * than five. Deployments that want to trade freshness for load can raise
   * `ACCESS_CACHE_TTL_SECONDS`, but the default should be the safe one.
   */
  private async resolveAccess(userId: string, organizationId?: string) {
    const cacheKey = `access:${userId}:${organizationId ?? 'default'}`;
    const cached = await this.cache.get<{
      organizationId: string;
      organizationName: string;
      roleKey: string;
      permissions: string[];
    }>(cacheKey);
    if (cached) return cached;

    const membership = organizationId
      ? await this.memberships.findAccess(userId, organizationId)
      : await this.memberships.findFirstForUser(userId);

    if (!membership) {
      throw new ForbiddenException(
        organizationId
          ? 'You are not a member of that organization'
          : 'This account has no active organization membership',
      );
    }

    const resolved = {
      organizationId: membership.organizationId,
      organizationName: membership.organization.name,
      roleKey: membership.role.key,
      permissions: membership.role.permissions.map((rp) => rp.permission.key),
    };

    await this.cache.set(cacheKey, resolved, AuthService.ACCESS_CACHE_TTL);
    return resolved;
  }

  /** Invalidates cached authorization for a user — call after role changes. */
  async invalidateAccess(userId: string): Promise<void> {
    await this.cache.deleteByPrefix(`access:${userId}`);
  }

  /**
   * Invalidates every member of an organization.
   *
   * Needed when a change affects more than one principal — a role's permission
   * set being edited, an organization being suspended. Reading the membership
   * list to do it costs a query, on an operation that happens rarely, in
   * exchange for revocation that takes effect on the next request rather than
   * on the next TTL expiry.
   */
  async invalidateOrganizationAccess(organizationId: string): Promise<void> {
    const members = await this.memberships
      .listByOrganization(organizationId)
      .catch(() => [] as Array<{ userId: string }>);
    await Promise.all(members.map((member) => this.invalidateAccess(member.userId)));
  }

  /**
   * Drops cached authorization whenever the platform says it changed.
   *
   * Subscribing rather than relying on call sites is the point. Every
   * invalidation that depends on somebody remembering to call it is one
   * refactor away from silently not happening, and the failure is invisible:
   * permissions keep working, for up to a TTL, for someone who no longer has
   * them. An event the mutation already publishes cannot be forgotten in the
   * same way.
   */
  onModuleInit(): void {
    const invalidate = async (envelope: DomainEventEnvelope): Promise<void> => {
      const userId = envelope.payload?.userId;
      if (typeof userId === 'string' && userId) {
        await this.invalidateAccess(userId);
        return;
      }
      // No specific user named: the change is organization-wide.
      if (envelope.organizationId) {
        await this.invalidateOrganizationAccess(envelope.organizationId);
      }
    };

    this.events.on(DomainEvent.MemberAccessChanged, invalidate);
    this.events.on(DomainEvent.UserRemoved, invalidate);
  }

  /**
   * Maps a provider identity onto our local user row, creating it on first
   * sight. With Supabase, an account may exist upstream before we have ever
   * seen it (invited via the dashboard, OAuth, etc.).
   */
  private async resolveLocalUser(email: string, externalId: string | null) {
    let user = externalId ? await this.users.findBySupabaseId(externalId) : null;
    user ??= await this.users.findByEmail(email);

    if (!user) {
      user = await this.users.create({
        email,
        supabaseUserId: externalId,
        emailVerified: true,
      });
      this.logger.log(`Provisioned local user record for ${email}`);
    } else if (externalId && !user.supabaseUserId) {
      user = await this.users.update(user.id, { supabaseUserId: externalId });
    }

    if (!user) throw new UnauthorizedException('Unable to resolve user');
    return user;
  }

  private async uniqueSlug(base: string, tx?: Parameters<typeof this.organizations.findBySlug>[1]) {
    const root =
      base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace';

    let candidate = root;
    let suffix = 1;
    while (await this.organizations.findBySlug(candidate, tx)) {
      candidate = `${root}-${++suffix}`;
    }
    return candidate;
  }

  /** Runs `fn` with an explicit context — used by background jobs and seeds. */
  static async asSystem<T>(
    ctx: { userId: string; organizationId: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    return RequestContextStore.run(
      {
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        roleKey: SystemRole.Owner,
        permissions: ['*'],
        requestId: `system-${Date.now()}`,
      },
      fn,
    );
  }
}
