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
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { WorkersService } from './workers.service';
import {
  CreateWorkerDto,
  QueryWorkersDto,
  UpdateWorkerDto,
  WorkerResponseDto,
} from './dto/worker.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

@ApiTags('Workers')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Your role lacks the required permission.' })
@Controller('workers')
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @Post()
  @RequirePermissions(Permissions.WorkerCreate)
  @ApiOperation({
    summary: 'Create a worker',
    description:
      'Creates a worker in the caller’s organization. Workers start DORMANT and ' +
      'must be activated before they can take work. Emits `worker.created`.',
  })
  @ApiCreatedResponse({ type: WorkerResponseDto })
  @ApiNotFoundResponse({ description: 'The referenced provider does not exist in this organization.' })
  create(@Body() dto: CreateWorkerDto) {
    return this.workers.create(dto);
  }

  @Get()
  @RequirePermissions(Permissions.WorkerRead)
  @ApiOperation({ summary: 'List workers', description: 'Paginated, filterable by status and role.' })
  @ApiOkResponse({
    schema: {
      example: {
        data: [
          {
            id: 'clx0worker001',
            organizationId: 'clx0org0001',
            name: 'Market Scout',
            role: 'researcher',
            status: 'ACTIVE',
            capabilities: ['web-search', 'summarize'],
            generation: 1,
            fitness: 0.82,
            createdAt: '2026-08-02T11:44:51.312Z',
          },
        ],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrevious: false },
      },
    },
  })
  findAll(@Query() query: QueryWorkersDto) {
    return this.workers.findAll(query);
  }

  @Get('statistics')
  @RequirePermissions(Permissions.WorkerRead)
  @ApiOperation({ summary: 'Worker counts by status' })
  @ApiOkResponse({ schema: { example: { total: 12, active: 7, learning: 2, dormant: 3 } } })
  statistics() {
    return this.workers.statistics();
  }

  @Get(':id')
  @RequirePermissions(Permissions.WorkerRead)
  @ApiParam({ name: 'id', example: 'clx0worker001' })
  @ApiOperation({ summary: 'Get a worker' })
  @ApiOkResponse({ type: WorkerResponseDto })
  @ApiNotFoundResponse({ description: 'No such worker in this organization.' })
  findOne(@Param('id') id: string) {
    return this.workers.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(Permissions.WorkerUpdate)
  @ApiParam({ name: 'id', example: 'clx0worker001' })
  @ApiOperation({ summary: 'Update a worker', description: 'Emits `worker.updated`.' })
  @ApiOkResponse({ type: WorkerResponseDto })
  update(@Param('id') id: string, @Body() dto: UpdateWorkerDto) {
    return this.workers.update(id, dto);
  }

  @Post(':id/activate')
  @RequirePermissions(Permissions.WorkerUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0worker001' })
  @ApiOperation({
    summary: 'Activate a worker',
    description: 'Moves the worker to ACTIVE. Requires at least one capability.',
  })
  @ApiOkResponse({ type: WorkerResponseDto })
  @ApiBadRequestResponse({ description: 'The worker has no capabilities.' })
  activate(@Param('id') id: string) {
    return this.workers.activate(id);
  }

  @Post(':id/archive')
  @RequirePermissions(Permissions.WorkerUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0worker001' })
  @ApiOperation({ summary: 'Archive a worker', description: 'Emits `worker.archived`.' })
  @ApiOkResponse({ type: WorkerResponseDto })
  archive(@Param('id') id: string) {
    return this.workers.archive(id);
  }

  @Delete(':id')
  @RequirePermissions(Permissions.WorkerDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0worker001' })
  @ApiOperation({
    summary: 'Delete a worker',
    description: 'Soft-deletes the worker. Rejected while it has running tasks.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiBadRequestResponse({ description: 'The worker still has running tasks.' })
  remove(@Param('id') id: string) {
    return this.workers.remove(id);
  }
}
