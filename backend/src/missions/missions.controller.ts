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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { MissionsService } from './missions.service';
import {
  CreateMissionDto,
  CreateTaskDto,
  MissionResponseDto,
  QueryMissionsDto,
  UpdateMissionDto,
  UpdateTaskDto,
} from './dto/mission.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

@ApiTags('Missions')
@ApiBearerAuth()
@Controller('missions')
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  @Post()
  @RequirePermissions(Permissions.MissionCreate)
  @ApiOperation({
    summary: 'Create a mission',
    description:
      'Creates a mission in DRAFT, optionally with its task graph. Within `tasks`, ' +
      '`dependsOn` entries may be array indices ("0", "1") — they are rewritten to ' +
      'real task ids once the tasks exist. The graph is rejected if it contains a cycle.',
  })
  @ApiCreatedResponse({ type: MissionResponseDto })
  @ApiBadRequestResponse({ description: 'The task graph contains a cycle.' })
  create(@Body() dto: CreateMissionDto) {
    return this.missions.create(dto);
  }

  @Get()
  @RequirePermissions(Permissions.MissionRead)
  @ApiOperation({ summary: 'List missions' })
  @ApiOkResponse({
    schema: {
      example: {
        data: [
          {
            id: 'clx0mission01',
            title: 'Q3 competitive sweep',
            status: 'RUNNING',
            priority: 'HIGH',
            progress: 40,
            createdAt: '2026-08-02T11:44:51.312Z',
          },
        ],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrevious: false },
      },
    },
  })
  findAll(@Query() query: QueryMissionsDto) {
    return this.missions.findAll(query);
  }

  @Get('statistics')
  @RequirePermissions(Permissions.MissionRead)
  @ApiOperation({ summary: 'Mission counts by status' })
  @ApiOkResponse({ schema: { example: { total: 24, running: 3, completed: 19, failed: 2 } } })
  statistics() {
    return this.missions.statistics();
  }

  @Get(':id')
  @RequirePermissions(Permissions.MissionRead)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({ summary: 'Get a mission with its tasks' })
  @ApiOkResponse({ type: MissionResponseDto })
  @ApiNotFoundResponse({ description: 'No such mission in this organization.' })
  findOne(@Param('id') id: string) {
    return this.missions.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(Permissions.MissionUpdate)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'Update a mission',
    description: 'Title and objective are locked while the mission is RUNNING.',
  })
  @ApiOkResponse({ type: MissionResponseDto })
  update(@Param('id') id: string, @Body() dto: UpdateMissionDto) {
    return this.missions.update(id, dto);
  }

  @Post(':id/start')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'Start a mission',
    description: 'DRAFT → RUNNING. Requires at least one task. Emits `mission.started`.',
  })
  @ApiOkResponse({ type: MissionResponseDto })
  @ApiBadRequestResponse({ description: 'Illegal state transition, or the mission has no tasks.' })
  start(@Param('id') id: string) {
    return this.missions.start(id);
  }

  @Post(':id/pause')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({ summary: 'Pause a running mission' })
  @ApiOkResponse({ type: MissionResponseDto })
  pause(@Param('id') id: string) {
    return this.missions.pause(id);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({ summary: 'Cancel a mission', description: 'Terminal — cannot be restarted.' })
  @ApiOkResponse({ type: MissionResponseDto })
  cancel(@Param('id') id: string) {
    return this.missions.cancel(id);
  }

  @Delete(':id')
  @RequirePermissions(Permissions.MissionDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({ summary: 'Delete a mission', description: 'Cancel it first if it is running.' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  remove(@Param('id') id: string) {
    return this.missions.remove(id);
  }

  // --------------------------------------------------------------
  // Tasks
  // --------------------------------------------------------------

  @Get(':id/tasks')
  @RequirePermissions(Permissions.MissionRead)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({ summary: 'List a mission’s tasks' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0task001',
          title: 'Collect competitor pricing',
          status: 'COMPLETED',
          priority: 'HIGH',
          dependsOn: [],
          workerId: 'clx0worker001',
        },
      ],
    },
  })
  listTasks(@Param('id') id: string) {
    return this.missions.listTasks(id);
  }

  @Get(':id/tasks/runnable')
  @RequirePermissions(Permissions.MissionRead)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'List tasks ready to run',
    description:
      'Pending tasks whose dependencies have all completed — the mission’s current ready set.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0task001',
          title: 'Collect competitor pricing',
          status: 'PENDING',
          dependsOn: [],
          workerId: 'clx0worker001',
        },
      ],
    },
  })
  listRunnable(@Param('id') id: string) {
    return this.missions.listRunnableTasks(id);
  }

  @Post(':id/tasks')
  @RequirePermissions(Permissions.MissionUpdate)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'Add a task to a mission',
    description: '`dependsOn` must reference tasks already in this mission.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0task002',
        missionId: 'clx0mission01',
        title: 'Summarise deltas',
        status: 'PENDING',
        priority: 'MEDIUM',
        dependsOn: ['clx0task001'],
        workerId: null,
        attempts: 0,
        createdAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  addTask(@Param('id') id: string, @Body() dto: CreateTaskDto) {
    return this.missions.addTask(id, dto);
  }

  @Patch(':id/tasks/:taskId')
  @RequirePermissions(Permissions.MissionUpdate)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiParam({ name: 'taskId', example: 'clx0task001' })
  @ApiOperation({
    summary: 'Update a task',
    description:
      'Recomputes mission progress. When the final task completes the mission is ' +
      'completed automatically and `mission.completed` is emitted.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0task001',
        status: 'COMPLETED',
        result: { findings: 3 },
        completedAt: '2026-08-02T12:03:11.900Z',
      },
    },
  })
  updateTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.missions.updateTask(id, taskId, dto);
  }
}
