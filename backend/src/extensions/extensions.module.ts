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
import { RequestContextStore } from '../shared/context/request-context';
import { PaginationQueryDto, paginate } from '../shared/dto/pagination.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';
import { PlatformModule } from '../platform/platform.module';
import { ExtensionRuntimeService } from '../platform/extension-runtime.service';

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

/**
 * The simple extension registry.
 *
 * Phase 7 replaced the machinery behind these endpoints with the full
 * lifecycle — validation, the capability grant, contribution registration,
 * initialization, the audit trail. This service now composes a manifest from
 * the flat DTO and hands it to `ExtensionRuntimeService`, so there is exactly
 * one install path rather than two that could disagree about what an
 * extension is allowed to do.
 *
 * The endpoints and their shapes are unchanged: an extension installed here
 * declares no capabilities, holds an empty grant, and is therefore denied
 * every host call. That is the correct outcome for a manifest that asked for
 * nothing, and it is why the two paths can safely share a table.
 */
@Injectable()
export class ExtensionsService {
  constructor(
    private readonly extensions: ExtensionRepository,
    private readonly runtime: ExtensionRuntimeService,
  ) {}

  async install(dto: InstallExtensionDto): Promise<Extension> {
    if (await this.extensions.findBySlug(dto.slug)) {
      throw new ConflictException(`An extension with slug "${dto.slug}" is already installed`);
    }

    const supplied = (dto.manifest ?? {}) as Record<string, unknown>;
    const result = await this.runtime.install({
      manifest: {
        // Anything the caller put in `manifest` is honoured — capabilities,
        // contributions, config — but identity always comes from the DTO,
        // which is what these endpoints have always treated as canonical.
        ...supplied,
        slug: dto.slug,
        name: dto.name,
        version: dto.version ?? '1.0.0',
        capabilities: Array.isArray(supplied.capabilities) ? supplied.capabilities : [],
        subscribes: dto.subscribes ?? [],
      },
    });

    return result.extension!;
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

  enable(id: string): Promise<Extension> {
    return this.runtime.enable(id);
  }

  disable(id: string): Promise<Extension> {
    return this.runtime.disable(id);
  }

  remove(id: string): Promise<void> {
    return this.runtime.uninstall(id);
  }
}

/**
 * Delivers domain events to the extensions that subscribed to them.
 *
 * Phase 1 established the subscription wiring and logged what *would* have
 * been delivered. Phase 7 makes the delivery real: each subscriber is handed
 * the event through the sandbox, under its own grant, and one extension
 * failing on one event neither stops the others nor goes unrecorded.
 */
@Injectable()
export class ExtensionEventBridge implements OnModuleInit {
  private readonly logger = new Logger(ExtensionEventBridge.name);

  constructor(
    private readonly bus: EventBusService,
    private readonly extensions: ExtensionRepository,
    private readonly runtime: ExtensionRuntimeService,
  ) {}

  onModuleInit(): void {
    this.bus.onAny(async (event) => {
      // Extension-lifecycle events would recurse back into this handler.
      if (event.name.startsWith('extension.')) return;

      try {
        // The bus delivers asynchronously, after the originating request's
        // context has been torn down, so the tenant has to be re-entered from
        // the envelope. Without this every lookup below fails closed — which
        // is the right failure, but it means no extension ever hears anything.
        await RequestContextStore.run(
          {
            userId: 'system',
            organizationId: event.organizationId,
            roleKey: 'SYSTEM',
            permissions: ['*'],
            requestId: `extension-fanout-${event.name}`,
          },
          async () => {
            const subscribers = await this.extensions.findSubscribers(event.name);
            if (!subscribers.length) return;

            this.logger.debug(`"${event.name}" -> ${subscribers.map((e) => e.slug).join(', ')}`);

            // Sequential rather than parallel: each delivery draws on the
            // extension's own rate budget, and fanning out concurrently would
            // let one busy event burn a whole minute's allowance at once.
            for (const subscriber of subscribers) {
              await this.runtime.deliver(subscriber, {
                name: event.name,
                payload: event.payload as Record<string, unknown>,
              });
            }
          },
        );
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
  imports: [PlatformModule],
  controllers: [ExtensionsController],
  providers: [ExtensionsService, ExtensionEventBridge],
  exports: [ExtensionsService],
})
export class ExtensionsModule {}
