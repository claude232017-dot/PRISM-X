import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsEmail, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  MembershipRepository,
  OrganizationRepository,
  RoleRepository,
  UserRepository,
} from '../database/repositories/identity.repositories';
import { AuthService } from '../auth/auth.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { CurrentUser, RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions, SystemRole } from '../auth/permissions';
import type { AuthenticatedPrincipal } from '../auth/auth.service';

// ---------------------------------------------------------------- DTOs

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'Prism Labs' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: { timezone: 'Europe/Berlin', locale: 'en' } })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

export class InviteMemberDto {
  @ApiProperty({ example: 'analyst@prism-x.io' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: SystemRole.Operator,
    enum: [SystemRole.Owner, SystemRole.Admin, SystemRole.Operator, SystemRole.Viewer],
  })
  @IsIn([SystemRole.Owner, SystemRole.Admin, SystemRole.Operator, SystemRole.Viewer])
  role!: string;
}

export class ChangeMemberRoleDto {
  @ApiProperty({
    example: SystemRole.Admin,
    enum: [SystemRole.Owner, SystemRole.Admin, SystemRole.Operator, SystemRole.Viewer],
  })
  @IsIn([SystemRole.Owner, SystemRole.Admin, SystemRole.Operator, SystemRole.Viewer])
  role!: string;
}

// ------------------------------------------------------------- Service

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly memberships: MembershipRepository,
    private readonly users: UserRepository,
    private readonly roles: RoleRepository,
    private readonly auth: AuthService,
    private readonly events: EventBusService,
  ) {}

  async findCurrent(organizationId: string) {
    const organization = await this.organizations.findById(organizationId);
    if (!organization) throw new NotFoundException('Organization not found');

    const memberCount = (await this.memberships.listByOrganization(organizationId)).length;
    return { ...organization, memberCount };
  }

  listForUser(userId: string) {
    return this.organizations.findForUser(userId);
  }

  async update(organizationId: string, dto: UpdateOrganizationDto) {
    await this.findCurrent(organizationId);
    const updated = await this.organizations.update(
      organizationId,
      dto as Record<string, never>,
    );
    await this.events.publish(DomainEvent.OrganizationUpdated, {
      organizationId,
      changes: Object.keys(dto),
    });
    return updated;
  }

  async remove(organizationId: string): Promise<void> {
    await this.findCurrent(organizationId);
    await this.organizations.softDelete(organizationId);
    await this.events.publish(DomainEvent.OrganizationDeleted, { organizationId });
  }

  async listMembers(organizationId: string) {
    const memberships = await this.memberships.listByOrganization(organizationId);
    return memberships.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      email: m.user.email,
      displayName: m.user.displayName,
      role: m.role.key,
      status: m.status,
      joinedAt: m.joinedAt,
    }));
  }

  /**
   * Invites a user into the organization.
   *
   * If no account exists yet, a shell user row is created so the membership
   * can be recorded; the person completes registration later and the existing
   * membership is picked up by email.
   */
  async inviteMember(organizationId: string, dto: InviteMemberDto) {
    const role = await this.roles.findByKey(dto.role, null);
    if (!role) throw new BadRequestException(`Unknown role "${dto.role}"`);

    let user = await this.users.findByEmail(dto.email);
    user ??= await this.users.create({ email: dto.email, emailVerified: false });

    const existing = await this.memberships.findAccess(user.id, organizationId);
    if (existing) {
      throw new ConflictException('That user is already a member of this organization');
    }

    const membership = await this.memberships.create({
      userId: user.id,
      organizationId,
      roleId: role.id,
      status: 'INVITED',
      invitedAt: new Date(),
    });

    await this.events.publish(DomainEvent.UserInvited, {
      userId: user.id,
      email: user.email,
      role: dto.role,
    });

    return {
      membershipId: membership.id,
      userId: user.id,
      email: user.email,
      role: role.key,
      status: membership.status,
    };
  }

  async changeMemberRole(
    organizationId: string,
    membershipId: string,
    dto: ChangeMemberRoleDto,
    actingUserId: string,
  ) {
    const members = await this.memberships.listByOrganization(organizationId);
    const membership = members.find((m) => m.id === membershipId);
    if (!membership) throw new NotFoundException('Membership not found');

    const role = await this.roles.findByKey(dto.role, null);
    if (!role) throw new BadRequestException(`Unknown role "${dto.role}"`);

    // An organization with no owner cannot be administered or deleted, so the
    // last owner may not demote themselves.
    if (membership.role.key === SystemRole.Owner && dto.role !== SystemRole.Owner) {
      const owners = await this.memberships.countOwners(organizationId);
      if (owners <= 1) {
        throw new BadRequestException(
          'This is the last owner. Promote another member to owner first.',
        );
      }
    }

    const updated = await this.memberships.update(membershipId, { roleId: role.id });

    // The caller's cached permission set is now stale.
    await this.auth.invalidateAccess(membership.userId);
    if (membership.userId !== actingUserId) await this.auth.invalidateAccess(actingUserId);

    return { membershipId: updated.id, role: role.key };
  }

  async removeMember(organizationId: string, membershipId: string, actingUserId: string) {
    const members = await this.memberships.listByOrganization(organizationId);
    const membership = members.find((m) => m.id === membershipId);
    if (!membership) throw new NotFoundException('Membership not found');

    if (membership.userId === actingUserId) {
      throw new ForbiddenException('You cannot remove your own membership');
    }
    if (membership.role.key === SystemRole.Owner) {
      const owners = await this.memberships.countOwners(organizationId);
      if (owners <= 1) {
        throw new BadRequestException('Cannot remove the last owner of an organization');
      }
    }

    await this.memberships.remove(membershipId);
    await this.auth.invalidateAccess(membership.userId);
    await this.events.publish(DomainEvent.UserRemoved, { userId: membership.userId });
  }
}

// ---------------------------------------------------------- Controller

@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get('current')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({
    summary: 'Get the current organization',
    description: 'The organization this request acts within, as resolved from the token.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0org0001',
        name: 'Prism Labs',
        slug: 'prism-labs',
        plan: 'FREE',
        settings: { timezone: 'Europe/Berlin' },
        memberCount: 4,
        createdAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  current(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.organizations.findCurrent(user.organizationId);
  }

  @Get('mine')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({
    summary: 'List organizations the caller belongs to',
    description: 'Use the returned id in the `X-Organization-Id` header to switch context.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        { id: 'clx0org0001', name: 'Prism Labs', slug: 'prism-labs', plan: 'FREE' },
        { id: 'clx0org0002', name: 'Side Project', slug: 'side-project', plan: 'FREE' },
      ],
    },
  })
  mine(@CurrentUser('userId') userId: string) {
    return this.organizations.listForUser(userId);
  }

  @Patch('current')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @ApiOperation({ summary: 'Update the current organization' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0org0001',
        name: 'Prism Labs',
        slug: 'prism-labs',
        plan: 'FREE',
        settings: { timezone: 'Europe/Berlin' },
        createdAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  update(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: UpdateOrganizationDto) {
    return this.organizations.update(user.organizationId, dto);
  }

  @Delete('current')
  @RequirePermissions(Permissions.OrganizationDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete the current organization',
    description: 'Soft delete. Owner only.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  remove(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.organizations.remove(user.organizationId);
  }

  @Get('current/members')
  @RequirePermissions(Permissions.MemberRead)
  @ApiOperation({ summary: 'List members' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          membershipId: 'clx0mem00001',
          userId: 'clx0user0001',
          email: 'operator@prism-x.io',
          displayName: 'Ada Lovelace',
          role: 'OWNER',
          status: 'ACTIVE',
          joinedAt: '2026-08-02T11:44:51.312Z',
        },
      ],
    },
  })
  listMembers(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.organizations.listMembers(user.organizationId);
  }

  @Post('current/members')
  @RequirePermissions(Permissions.MemberInvite)
  @ApiOperation({
    summary: 'Invite a member',
    description:
      'Creates an INVITED membership. If the email has no account yet, a shell user ' +
      'is created and linked when they register. Emits `user.invited`.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        membershipId: 'clx0mem00002',
        userId: 'clx0user0002',
        email: 'analyst@prism-x.io',
        role: 'OPERATOR',
        status: 'INVITED',
      },
    },
  })
  invite(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: InviteMemberDto) {
    return this.organizations.inviteMember(user.organizationId, dto);
  }

  @Patch('current/members/:membershipId')
  @RequirePermissions(Permissions.MemberUpdate)
  @ApiParam({ name: 'membershipId', example: 'clx0mem00001' })
  @ApiOperation({
    summary: 'Change a member’s role',
    description: 'The last remaining owner cannot be demoted.',
  })
  @ApiOkResponse({
    schema: { example: { membershipId: 'clx0mem00002', role: 'ADMIN' } },
  })
  changeRole(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('membershipId') membershipId: string,
    @Body() dto: ChangeMemberRoleDto,
  ) {
    return this.organizations.changeMemberRole(
      user.organizationId,
      membershipId,
      dto,
      user.userId,
    );
  }

  @Delete('current/members/:membershipId')
  @RequirePermissions(Permissions.MemberRemove)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'membershipId', example: 'clx0mem00001' })
  @ApiOperation({
    summary: 'Remove a member',
    description: 'You cannot remove yourself, nor the last owner.',
  })
  @ApiNoContentResponse({ description: 'Removed.' })
  removeMember(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('membershipId') membershipId: string,
  ) {
    return this.organizations.removeMember(user.organizationId, membershipId, user.userId);
  }
}

@Module({
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
