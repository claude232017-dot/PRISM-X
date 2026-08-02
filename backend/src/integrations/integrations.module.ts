import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
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
  PartialType,
} from '@nestjs/swagger';
import { Integration, IntegrationCategory, IntegrationStatus } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  CredentialRepository,
  IntegrationRepository,
} from '../database/repositories/tenant.repositories';
import { CryptoService } from '../shared/crypto/crypto.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { PaginationQueryDto, paginate } from '../shared/dto/pagination.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

// ---------------------------------------------------------------- DTOs

export class CreateIntegrationDto {
  @ApiProperty({ example: 'Ops Slack workspace' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    example: 'slack',
    description: 'Integration type slug — resolves to a connector in a later phase.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  kind!: string;

  @ApiPropertyOptional({ example: { channel: '#prism-alerts' } })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Secret token. Encrypted at rest and never returned.',
  })
  @IsOptional()
  @IsString()
  secret?: string;

  // --- Phase 3: connector metadata ---------------------------------

  @ApiPropertyOptional({
    enum: IntegrationCategory,
    description: 'Service category. Inferred from the connector when omitted.',
  })
  @IsOptional()
  @IsEnum(IntegrationCategory)
  category?: IntegrationCategory;

  @ApiPropertyOptional({
    example: 'api_key',
    description: 'api_key | bearer | basic | oauth2 | none. Inferred from the connector when omitted.',
  })
  @IsOptional()
  @IsString()
  authMethod?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['send', 'read'],
    description:
      'Operations this integration may perform. Empty means the connector default. ' +
      'An action outside this set is refused before the call leaves the process.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}

export class UpdateIntegrationDto extends PartialType(CreateIntegrationDto) {}

export class QueryIntegrationsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: IntegrationStatus })
  @IsOptional()
  @IsEnum(IntegrationStatus)
  status?: IntegrationStatus;

  @ApiPropertyOptional({ example: 'slack' })
  @IsOptional()
  @IsString()
  kind?: string;
}

// ------------------------------------------------------------- Service

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly integrations: IntegrationRepository,
    private readonly credentials: CredentialRepository,
    private readonly crypto: CryptoService,
    private readonly events: EventBusService,
  ) {}

  async create(dto: CreateIntegrationDto): Promise<Integration> {
    let credentialId: string | null = null;

    if (dto.secret) {
      const sealed = this.crypto.seal(dto.secret);
      const credential = await this.credentials.create({
        name: `${dto.name} secret`,
        type: `integration:${dto.kind}`,
        value: sealed.value,
        iv: sealed.iv,
        authTag: sealed.authTag,
      });
      credentialId = credential.id;
    }

    const integration = await this.integrations.create({
      name: dto.name,
      kind: dto.kind,
      config: (dto.config ?? {}) as never,
      credentialId,
      status: IntegrationStatus.INACTIVE,
      ...(dto.category ? { category: dto.category } : {}),
      ...(dto.authMethod ? { authMethod: dto.authMethod } : {}),
      permissions: dto.permissions ?? [],
    });

    await this.events.publish(DomainEvent.IntegrationCreated, {
      integrationId: integration.id,
      kind: integration.kind,
    });
    return integration;
  }

  async findAll(query: QueryIntegrationsDto) {
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.kind) where.kind = query.kind;

    const { rows, total } = await this.integrations.paginate(where, {
      skip: query.skip,
      take: query.limit,
      orderBy: { [query.sortBy]: query.sortOrder },
    });
    return paginate(rows, total, query.page, query.limit);
  }

  findOne(id: string): Promise<Integration> {
    return this.integrations.findByIdOrFail(id);
  }

  async update(id: string, dto: UpdateIntegrationDto): Promise<Integration> {
    const integration = await this.integrations.findByIdOrFail(id);
    const patch: Record<string, unknown> = {};

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.config !== undefined) patch.config = dto.config;

    if (dto.secret) {
      const sealed = this.crypto.seal(dto.secret);
      if (integration.credentialId) {
        await this.credentials.update(integration.credentialId, {
          value: sealed.value,
          iv: sealed.iv,
          authTag: sealed.authTag,
        });
      } else {
        const credential = await this.credentials.create({
          name: `${integration.name} secret`,
          type: `integration:${integration.kind}`,
          value: sealed.value,
          iv: sealed.iv,
          authTag: sealed.authTag,
        });
        patch.credentialId = credential.id;
      }
    }

    return this.integrations.update(id, patch);
  }

  /** Activation requires configuration — an empty connector would no-op silently. */
  async activate(id: string): Promise<Integration> {
    const integration = await this.integrations.findByIdOrFail(id);
    const config = (integration.config ?? {}) as Record<string, unknown>;

    if (!integration.credentialId && Object.keys(config).length === 0) {
      throw new BadRequestException(
        'Configure the integration (credentials or config) before activating it',
      );
    }

    const updated = await this.integrations.update(id, {
      status: IntegrationStatus.ACTIVE,
      lastSyncAt: new Date(),
    });
    await this.events.publish(DomainEvent.IntegrationActivated, { integrationId: id });
    return updated;
  }

  async deactivate(id: string): Promise<Integration> {
    await this.integrations.findByIdOrFail(id);
    return this.integrations.update(id, { status: IntegrationStatus.INACTIVE });
  }

  async remove(id: string): Promise<void> {
    const integration = await this.integrations.findByIdOrFail(id);
    await this.integrations.remove(id);
    if (integration.credentialId) await this.credentials.purge(integration.credentialId);
  }
}

// ---------------------------------------------------------- Controller

@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Post()
  @RequirePermissions(Permissions.IntegrationCreate)
  @ApiOperation({
    summary: 'Create an integration',
    description:
      'Stores connector configuration. Any `secret` is encrypted at rest and never ' +
      'returned. Integrations start INACTIVE. Emits `integration.created`.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0int00001',
        name: 'Ops Slack workspace',
        kind: 'slack',
        status: 'INACTIVE',
        config: { channel: '#prism-alerts' },
        lastSyncAt: null,
        createdAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  create(@Body() dto: CreateIntegrationDto) {
    return this.integrations.create(dto);
  }

  @Get()
  @RequirePermissions(Permissions.IntegrationRead)
  @ApiOperation({ summary: 'List integrations' })
  @ApiOkResponse({
    schema: {
      example: {
        data: [
          {
            id: 'clx0int00001',
            name: 'Ops Slack workspace',
            kind: 'slack',
            status: 'ACTIVE',
            lastSyncAt: '2026-08-02T11:44:51.312Z',
          },
        ],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrevious: false },
      },
    },
  })
  findAll(@Query() query: QueryIntegrationsDto) {
    return this.integrations.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(Permissions.IntegrationRead)
  @ApiParam({ name: 'id', example: 'clx0int00001' })
  @ApiOperation({ summary: 'Get an integration' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0int00001',
        name: 'Ops Slack workspace',
        kind: 'slack',
        status: 'INACTIVE',
        config: { channel: '#prism-alerts' },
        lastSyncAt: null,
        createdAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  findOne(@Param('id') id: string) {
    return this.integrations.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(Permissions.IntegrationUpdate)
  @ApiParam({ name: 'id', example: 'clx0int00001' })
  @ApiOperation({ summary: 'Update an integration' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0int00001',
        name: 'Ops Slack workspace',
        kind: 'slack',
        status: 'INACTIVE',
        config: { channel: '#prism-alerts' },
        lastSyncAt: null,
        createdAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  update(@Param('id') id: string, @Body() dto: UpdateIntegrationDto) {
    return this.integrations.update(id, dto);
  }

  @Post(':id/activate')
  @RequirePermissions(Permissions.IntegrationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0int00001' })
  @ApiOperation({
    summary: 'Activate an integration',
    description: 'Requires credentials or config to be present first.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0int00001',
        status: 'ACTIVE',
        lastSyncAt: '2026-08-02T12:03:11.900Z',
      },
    },
  })
  activate(@Param('id') id: string) {
    return this.integrations.activate(id);
  }

  @Post(':id/deactivate')
  @RequirePermissions(Permissions.IntegrationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0int00001' })
  @ApiOperation({ summary: 'Deactivate an integration' })
  @ApiOkResponse({ schema: { example: { id: 'clx0int00001', status: 'INACTIVE' } } })
  deactivate(@Param('id') id: string) {
    return this.integrations.deactivate(id);
  }

  @Delete(':id')
  @RequirePermissions(Permissions.IntegrationDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0int00001' })
  @ApiOperation({ summary: 'Delete an integration', description: 'Purges its stored secret.' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  remove(@Param('id') id: string) {
    return this.integrations.remove(id);
  }
}

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
