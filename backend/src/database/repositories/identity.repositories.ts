import { Injectable } from '@nestjs/common';
import type { Membership, Organization, Permission, Role, User } from '@prisma/client';
import { PrismaService, PrismaTx } from '../prisma.service';

/**
 * Identity-plane repositories.
 *
 * These deliberately do NOT extend BaseRepository: users, organizations, roles
 * and permissions are not themselves owned by a tenant, so the automatic
 * `organizationId` predicate would be wrong. Access control for these lives in
 * the service layer and in the membership lookup below.
 */

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: PrismaTx) {
    return (tx ?? this.prisma).user;
  }

  findById(id: string, tx?: PrismaTx): Promise<User | null> {
    return this.db(tx).findFirst({ where: { id, deletedAt: null } });
  }

  findByEmail(email: string, tx?: PrismaTx): Promise<User | null> {
    return this.db(tx).findFirst({
      where: { email: email.toLowerCase(), deletedAt: null },
    });
  }

  findBySupabaseId(supabaseUserId: string, tx?: PrismaTx): Promise<User | null> {
    return this.db(tx).findFirst({ where: { supabaseUserId, deletedAt: null } });
  }

  create(data: {
    email: string;
    displayName?: string | null;
    passwordHash?: string | null;
    supabaseUserId?: string | null;
    emailVerified?: boolean;
  }, tx?: PrismaTx): Promise<User> {
    return this.db(tx).create({
      data: { ...data, email: data.email.toLowerCase() },
    });
  }

  update(id: string, data: Partial<User>, tx?: PrismaTx): Promise<User> {
    return this.db(tx).update({ where: { id }, data });
  }

  markLogin(id: string): Promise<User> {
    return this.db().update({ where: { id }, data: { lastLoginAt: new Date() } });
  }

  async softDelete(id: string): Promise<void> {
    await this.db().update({ where: { id }, data: { deletedAt: new Date() } });
  }
}

@Injectable()
export class OrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: PrismaTx) {
    return (tx ?? this.prisma).organization;
  }

  findById(id: string, tx?: PrismaTx): Promise<Organization | null> {
    return this.db(tx).findFirst({ where: { id, deletedAt: null } });
  }

  findBySlug(slug: string, tx?: PrismaTx): Promise<Organization | null> {
    return this.db(tx).findFirst({ where: { slug, deletedAt: null } });
  }

  create(
    data: { name: string; slug: string; plan?: Organization['plan'] },
    tx?: PrismaTx,
  ): Promise<Organization> {
    return this.db(tx).create({ data });
  }

  update(
    id: string,
    data: Record<string, unknown>,
    tx?: PrismaTx,
  ): Promise<Organization> {
    return this.db(tx).update({ where: { id }, data });
  }

  async softDelete(id: string, tx?: PrismaTx): Promise<void> {
    await this.db(tx).update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /** Every organization a user belongs to, with their role in each. */
  findForUser(userId: string): Promise<Organization[]> {
    return this.db().findMany({
      where: {
        deletedAt: null,
        memberships: { some: { userId, status: 'ACTIVE' } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}

export type MembershipWithAccess = Membership & {
  role: Role & { permissions: { permission: Permission }[] };
  organization: Organization;
};

@Injectable()
export class MembershipRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: PrismaTx) {
    return (tx ?? this.prisma).membership;
  }

  /**
   * The authorization lookup: resolves a user's membership in one org along
   * with the fully expanded permission set for their role. Called once per
   * request by the JWT strategy and cached in Redis by AuthService.
   */
  findAccess(userId: string, organizationId: string): Promise<MembershipWithAccess | null> {
    return this.db().findFirst({
      where: { userId, organizationId, status: 'ACTIVE' },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
        organization: true,
      },
    }) as Promise<MembershipWithAccess | null>;
  }

  findFirstForUser(userId: string): Promise<MembershipWithAccess | null> {
    return this.db().findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
        organization: true,
      },
    }) as Promise<MembershipWithAccess | null>;
  }

  listByOrganization(organizationId: string) {
    return this.db().findMany({
      where: { organizationId },
      include: { user: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  create(
    data: {
      userId: string;
      organizationId: string;
      roleId: string;
      status?: Membership['status'];
      invitedAt?: Date;
      joinedAt?: Date;
    },
    tx?: PrismaTx,
  ): Promise<Membership> {
    return this.db(tx).create({ data });
  }

  update(id: string, data: Partial<Membership>, tx?: PrismaTx): Promise<Membership> {
    return this.db(tx).update({ where: { id }, data });
  }

  async remove(id: string): Promise<void> {
    await this.db().delete({ where: { id } });
  }

  countOwners(organizationId: string): Promise<number> {
    return this.db().count({
      where: { organizationId, status: 'ACTIVE', role: { key: 'OWNER' } },
    });
  }
}

@Injectable()
export class RoleRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: PrismaTx) {
    return (tx ?? this.prisma).role;
  }

  /** System roles first, then any org-specific override of the same key. */
  findByKey(key: string, organizationId?: string | null, tx?: PrismaTx): Promise<Role | null> {
    return this.db(tx).findFirst({
      where: { key, organizationId: organizationId ?? null },
    });
  }

  listAvailable(organizationId: string): Promise<Role[]> {
    return this.db().findMany({
      where: { OR: [{ isSystem: true }, { organizationId }] },
      orderBy: { createdAt: 'asc' },
    });
  }

  findWithPermissions(id: string) {
    return this.db().findUnique({
      where: { id },
      include: { permissions: { include: { permission: true } } },
    });
  }
}

@Injectable()
export class PermissionRepository {
  constructor(private readonly prisma: PrismaService) {}

  listAll(): Promise<Permission[]> {
    return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
  }

  findByKeys(keys: string[]): Promise<Permission[]> {
    return this.prisma.permission.findMany({ where: { key: { in: keys } } });
  }
}

export const IDENTITY_REPOSITORIES = [
  UserRepository,
  OrganizationRepository,
  MembershipRepository,
  RoleRepository,
  PermissionRepository,
];
