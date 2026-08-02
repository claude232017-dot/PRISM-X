import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ProvidersService } from './providers.service';
import {
  CreateProviderDto,
  ProviderResponseDto,
  QueryProvidersDto,
  UpdateProviderDto,
} from './dto/provider.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

@ApiTags('Providers')
@ApiBearerAuth()
@Controller('providers')
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Post()
  @RequirePermissions(Permissions.ProviderCreate)
  @ApiOperation({
    summary: 'Register an intelligence provider',
    description:
      'Stores provider configuration. Any `apiKey` is encrypted with AES-256-GCM and ' +
      'is never returned — responses carry only a four-character hint. New providers ' +
      'start DISCONNECTED until a health check succeeds.',
  })
  @ApiCreatedResponse({ type: ProviderResponseDto })
  create(@Body() dto: CreateProviderDto) {
    return this.providers.create(dto);
  }

  @Get()
  @RequirePermissions(Permissions.ProviderRead)
  @ApiOperation({ summary: 'List providers' })
  @ApiOkResponse({
    schema: {
      example: {
        data: [
          {
            id: 'clx0prov0001',
            name: 'Primary reasoning provider',
            kind: 'ANTHROPIC',
            status: 'DISCONNECTED',
            isDefault: true,
            keyHint: '****f3a9',
            adapterAvailable: false,
            createdAt: '2026-08-02T11:44:51.312Z',
          },
        ],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrevious: false },
      },
    },
  })
  findAll(@Query() query: QueryProvidersDto) {
    return this.providers.findAll(query);
  }

  @Get('capabilities')
  @RequirePermissions(Permissions.ProviderRead)
  @ApiOperation({
    summary: 'List registered vendor adapters',
    description:
      'Reports which ProviderKinds currently have an execution adapter. Empty in ' +
      'Phase 1 by design — the abstraction ships before the vendors do.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        registered: [],
        note: 'Provider configuration is fully supported in Phase 1…',
      },
    },
  })
  capabilities() {
    return this.providers.capabilities();
  }

  @Get(':id')
  @RequirePermissions(Permissions.ProviderRead)
  @ApiParam({ name: 'id', example: 'clx0prov0001' })
  @ApiOperation({ summary: 'Get a provider' })
  @ApiOkResponse({ type: ProviderResponseDto })
  findOne(@Param('id') id: string) {
    return this.providers.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(Permissions.ProviderUpdate)
  @ApiParam({ name: 'id', example: 'clx0prov0001' })
  @ApiOperation({
    summary: 'Update a provider',
    description: 'Supplying a new `apiKey` rotates the credential and resets status.',
  })
  @ApiOkResponse({ type: ProviderResponseDto })
  update(@Param('id') id: string, @Body() dto: UpdateProviderDto) {
    return this.providers.update(id, dto);
  }

  @Post(':id/health-check')
  @RequirePermissions(Permissions.ProviderRead)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0prov0001' })
  @ApiOperation({
    summary: 'Probe a provider and record its status',
    description:
      'Reports `healthy: false` with an explanatory message when no adapter is ' +
      'registered for the provider’s kind, rather than claiming a false success.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        providerId: 'clx0prov0001',
        healthy: false,
        status: 'DISCONNECTED',
        message: 'No adapter is registered for "ANTHROPIC"…',
        checkedAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  healthCheck(@Param('id') id: string) {
    return this.providers.healthCheck(id);
  }

  @Delete(':id')
  @RequirePermissions(Permissions.ProviderDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0prov0001' })
  @ApiOperation({
    summary: 'Delete a provider',
    description: 'Rejected while workers still reference it. Purges the stored credential.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiBadRequestResponse({ description: 'Workers still use this provider.' })
  remove(@Param('id') id: string) {
    return this.providers.remove(id);
  }
}
