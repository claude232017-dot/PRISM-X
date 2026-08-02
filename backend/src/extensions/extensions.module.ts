import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
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
import { Extension, ExtensionStatus } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ExtensionRepository } from '../database/repositories/tenant.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { PaginationQueryDto, paginate } from '../shared/dto/pagination.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

// ---------------------------------------------------------------- DTOs

export class InstallExtensionDto {
  @ApiProperty({ example: 'LinkedIn Composer' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    example: 'linkedin-composer',
    description: 'URL-safe identifier, unique within the organization.',
  })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lower-case words separated by single hyphens',
  })
  slug!: string;

  @ApiPropertyOptional({ example: '1.2.0', default: '1.0.0' })
  @IsOptional()
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'version must be semver (e.g. 1.2.0)' })
  version?: string;

  @ApiPropertyOptional({ example: { author: 'Prism Labs', permissions: ['knowledge:read'] } })
  @IsOptional()
  @IsObject()
  manifest?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: [String],
    example: ['knowledge.stored', 'mission.completed'],
    description: 'Domain events this extension reacts to.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subscribes?: string[];
}

export class UpdateExtensionDto extends PartialType(InstallExtensionDto) {}

export class QueryExtensionsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ExtensionStatus })
  @IsOptional()
  @IsEnum(ExtensionStatus)
  status?: ExtensionStatus;
}

// ------------------------------------------------------------- Service

@Injectable()
export class ExtensionsService {
  constructor(
    private readonly extensions: ExtensionRepository,
    private readonly events: EventBusService,
  ) {}

  async install(dto: InstallExtensionDto): Promise<Extension> {
    if (await this.extensions.findBySlug(dto.slug)) {
      throw new ConflictException(`An extension with slug "${dto.slug}" is already installed`);
    }

    const extension = await this.extensions.create({
      name: dto.name,
      slug: dto.slug,
      version: dto.version ?? '1.0.0',
      manifest: (dto.manifest ?? {}) as never,
      subscribes: dto.subscribes ?? [],
      status: ExtensionStatus.INSTALLED,
    });

    await this.events.publish(DomainEvent.ExtensionInstalled, {
      extensionId: extension.id,
      slug: extension.slug,
    });
    return extension;
  }

  async findAll(query: QueryExtensionsDto) {
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;

    const { rows, total } = await this.extensions.paginate(where, {
      skip: query.skip,
      take: query.limit,
      orderBy: { [query.sortBy]: query.sortOrder },
    });
    return paginate(rows, total, query.page, query.limit);
  }

  findOne(id: string): Promise<Extension> {
    return this.extensions.findByIdOrFail(id);
  }

  async update(id: string, dto: UpdateExtensionDto): Promise<Extension> {
    await this.extensions.findByIdOrFail(id);
    const { slug: _immutable, ...patch } = dto;
    return this.extensions.update(id, patch as Record<string, unknown>);
  }

  async enable(id: string): Promise<Extension> {
    await this.extensions.findByIdOrFail(id);
    const updated = await this.extensions.update(id, { status: ExtensionStatus.ENABLED });
    await this.events.publish(DomainEvent.ExtensionEnabled, { extensionId: id });
    return updated;
  }

  async disable(id: string): Promise<Extension> {
    await this.extensions.findByIdOrFail(id);
    const updated = await this.extensions.update(id, { status: ExtensionStatus.DISABLED });
    await this.events.publish(DomainEvent.ExtensionDisabled, { extensionId: id });
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.extensions.findByIdOrFail(id);
    await this.extensions.remove(id);
  }
}

/**
 * Bridges the event bus to installed extensions.
 *
 * Phase 1 records which enabled extensions would have received each event.
 * Actual dispatch (sandboxed execution, webhooks) arrives in a later phase —
 * the subscription wiring is proven here so that adding delivery is a change
 * in one method rather than a new integration point.
 */
@Injectable()
export class ExtensionEventBridge implements OnModuleInit {
  private readonly logger = new Logger(ExtensionEventBridge.name);

  constructor(
    private readonly bus: EventBusService,
    private readonly extensions: ExtensionRepository,
  ) {}

  onModuleInit(): void {
    this.bus.onAny(async (event) => {
      // Extension-lifecycle events would recurse back into this handler.
      if (event.name.startsWith('extension.')) return;

      try {
        const subscribers = await this.extensions.findSubscribers(event.name);
        if (subscribers.length) {
          this.logger.debug(
            `"${event.name}" -> ${subscribers.map((e) => e.slug).join(', ')}`,
          );
        }
      } catch (error) {
        this.logger.error(`Extension fan-out failed: ${(error as Error).message}`);
      }
    });
  }
}

// ---------------------------------------------------------- Controller

@ApiTags('Extensions')
@ApiBearerAuth()
@Controller('extensions')
export class ExtensionsController {
  constructor(private readonly extensions: ExtensionsService) {}

  @Post()
  @RequirePermissions(Permissions.ExtensionInstall)
  @ApiOperation({
    summary: 'Install an extension',
    description:
      'Registers an extension and the domain events it subscribes to. Installed ' +
      'extensions are inert until enabled. Emits `extension.installed`.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0ext00001',
        name: 'LinkedIn Composer',
        slug: 'linkedin-composer',
        version: '1.2.0',
        status: 'INSTALLED',
        subscribes: ['knowledge.stored'],
        manifest: { author: 'Prism Labs' },
        createdAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  install(@Body() dto: InstallExtensionDto) {
    return this.extensions.install(dto);
  }

  @Get()
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiOperation({ summary: 'List installed extensions' })
  @ApiOkResponse({
    schema: {
      example: {
        data: [
          {
            id: 'clx0ext00001',
            name: 'LinkedIn Composer',
            slug: 'linkedin-composer',
            version: '1.2.0',
            status: 'ENABLED',
            subscribes: ['knowledge.stored'],
          },
        ],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrevious: false },
      },
    },
  })
  findAll(@Query() query: QueryExtensionsDto) {
    return this.extensions.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiParam({ name: 'id', example: 'clx0ext00001' })
  @ApiOperation({ summary: 'Get an extension' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0ext00001',
        name: 'LinkedIn Composer',
        slug: 'linkedin-composer',
        version: '1.2.0',
        status: 'INSTALLED',
        subscribes: ['knowledge.stored'],
        manifest: { author: 'Prism Labs' },
        createdAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  findOne(@Param('id') id: string) {
    return this.extensions.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(Permissions.ExtensionUpdate)
  @ApiParam({ name: 'id', example: 'clx0ext00001' })
  @ApiOperation({ summary: 'Update an extension', description: 'The slug is immutable.' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0ext00001',
        name: 'LinkedIn Composer',
        slug: 'linkedin-composer',
        version: '1.2.0',
        status: 'INSTALLED',
        subscribes: ['knowledge.stored'],
        manifest: { author: 'Prism Labs' },
        createdAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  update(@Param('id') id: string, @Body() dto: UpdateExtensionDto) {
    return this.extensions.update(id, dto);
  }

  @Post(':id/enable')
  @RequirePermissions(Permissions.ExtensionUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0ext00001' })
  @ApiOperation({ summary: 'Enable an extension', description: 'Starts receiving subscribed events.' })
  @ApiOkResponse({
    schema: { example: { id: 'clx0ext00001', slug: 'linkedin-composer', status: 'ENABLED' } },
  })
  enable(@Param('id') id: string) {
    return this.extensions.enable(id);
  }

  @Post(':id/disable')
  @RequirePermissions(Permissions.ExtensionUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0ext00001' })
  @ApiOperation({ summary: 'Disable an extension' })
  @ApiOkResponse({
    schema: { example: { id: 'clx0ext00001', slug: 'linkedin-composer', status: 'DISABLED' } },
  })
  disable(@Param('id') id: string) {
    return this.extensions.disable(id);
  }

  @Delete(':id')
  @RequirePermissions(Permissions.ExtensionDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0ext00001' })
  @ApiOperation({ summary: 'Uninstall an extension' })
  @ApiNoContentResponse({ description: 'Uninstalled.' })
  remove(@Param('id') id: string) {
    return this.extensions.remove(id);
  }
}

@Module({
  controllers: [ExtensionsController],
  providers: [ExtensionsService, ExtensionEventBridge],
  exports: [ExtensionsService],
})
export class ExtensionsModule {}
