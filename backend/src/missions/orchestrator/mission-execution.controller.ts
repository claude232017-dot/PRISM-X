import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { MissionOrchestrator } from './mission-orchestrator.service';
import { ExecutionLogRepository } from '../../database/repositories/execution.repositories';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { Permissions } from '../../auth/permissions';

/**
 * Execution-engine endpoints, kept separate from the CRUD controller so the
 * distinction between *describing* a mission and *running* one stays visible
 * in the API surface.
 */
@ApiTags('Missions')
@ApiBearerAuth()
@Controller('missions/:id')
export class MissionExecutionController {
  constructor(
    private readonly orchestrator: MissionOrchestrator,
    private readonly executionLogs: ExecutionLogRepository,
  ) {}

  @Post('plan')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'Plan a mission',
    description:
      'Assigns a worker to every unassigned task by role and skill match, then ' +
      'records the dependency waves that execution will follow. Fails if there are ' +
      'no tasks or no ACTIVE workers, rather than proceeding to a run that cannot ' +
      'succeed. Emits `mission.planned`.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0mission01',
        status: 'PLANNING',
        plan: {
          generatedAt: '2026-08-02T12:44:51.312Z',
          totalTasks: 3,
          waves: [
            { wave: 1, tasks: [{ id: 'clx0task001', title: 'Collect pricing', workerId: 'clx0worker001' }] },
            { wave: 2, tasks: [{ id: 'clx0task002', title: 'Summarise deltas', workerId: 'clx0worker002' }] },
          ],
        },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'No tasks, or no active workers to assign.' })
  plan(@Param('id') id: string) {
    return this.orchestrator.plan(id);
  }

  @Post('execute')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'Execute a mission',
    description:
      'Runs the mission to completion or to its first blocking condition. Plans ' +
      'first if needed, then walks the task graph in dependency waves — a task ' +
      'starts only once everything it depends on has completed, and receives those ' +
      'outputs as context. Mission status is derived from task state after each ' +
      'wave, so COMPLETED, FAILED and WAITING are reached automatically.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        missionId: 'clx0mission01',
        status: 'COMPLETED',
        tasksExecuted: 3,
        tasksSucceeded: 3,
        tasksFailed: 0,
        totalCostUsd: 0,
        totalTokens: 1524,
        durationMs: 96,
      },
    },
  })
  @ApiBadRequestResponse({ description: 'The mission is in a state that cannot be executed.' })
  execute(@Param('id') id: string) {
    return this.orchestrator.run(id);
  }

  @Post('resume')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'Resume a paused or waiting mission',
    description: 'Picks up from the current task state. Emits `mission.resumed`.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        missionId: 'clx0mission01',
        status: 'COMPLETED',
        tasksExecuted: 1,
        tasksSucceeded: 1,
        tasksFailed: 0,
        totalCostUsd: 0,
        totalTokens: 508,
        durationMs: 34,
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Mission is neither PAUSED nor WAITING.' })
  resume(@Param('id') id: string) {
    return this.orchestrator.resume(id);
  }

  @Post('retry')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'Retry a failed mission',
    description:
      'Resets failed tasks to PENDING and re-queues the mission. Bounded by the ' +
      'mission’s `maxRetries`. Emits `mission.retried`.',
  })
  @ApiOkResponse({
    schema: { example: { id: 'clx0mission01', status: 'QUEUED', retryCount: 1 } },
  })
  @ApiBadRequestResponse({ description: 'Retry limit reached, or illegal transition.' })
  retry(@Param('id') id: string) {
    return this.orchestrator.retry(id);
  }

  @Post('archive')
  @RequirePermissions(Permissions.MissionUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'Archive a mission',
    description: 'Terminal state for finished missions. Emits `mission.archived`.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0mission01',
        status: 'ARCHIVED',
        archivedAt: '2026-08-02T12:50:00.000Z',
      },
    },
  })
  archive(@Param('id') id: string) {
    return this.orchestrator.archive(id);
  }

  @Get('executions')
  @RequirePermissions(Permissions.MissionRead)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'Execution logs for a mission',
    description: 'Every AI call made on this mission’s behalf, newest first.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0exec0001',
          taskId: 'clx0task001',
          workerId: 'clx0worker001',
          model: 'prism-sim-1',
          status: 'SUCCEEDED',
          totalTokens: 508,
          costUsd: 0,
          latencyMs: 12,
          startedAt: '2026-08-02T12:44:51.312Z',
        },
      ],
    },
  })
  executions(@Param('id') id: string) {
    return this.executionLogs.findByMission(id);
  }

  @Get('cost')
  @RequirePermissions(Permissions.MissionRead)
  @ApiParam({ name: 'id', example: 'clx0mission01' })
  @ApiOperation({ summary: 'Cost and token totals for a mission' })
  @ApiOkResponse({
    schema: {
      example: {
        requests: 3,
        failedRequests: 0,
        successRate: 100,
        promptTokens: 1236,
        completionTokens: 288,
        totalTokens: 1524,
        costUsd: 0,
        averageLatencyMs: 13,
      },
    },
  })
  cost(@Param('id') id: string) {
    return this.executionLogs.summarize({ missionId: id });
  }
}
