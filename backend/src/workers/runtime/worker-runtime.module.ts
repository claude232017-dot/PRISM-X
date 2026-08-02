import { Body, Controller, Module, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { WorkerRuntimeService } from './worker-runtime.service';
import { MemoryModule } from '../../memory/memory.module';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { Permissions } from '../../auth/permissions';

export class ExecuteWorkerDto {
  @ApiProperty({
    example: 'Summarise what we know about competitor pricing changes this quarter.',
    description: 'What the worker should do.',
  })
  @IsString()
  @MinLength(2)
  instruction!: string;

  @ApiPropertyOptional({ description: 'Additional context, e.g. upstream task output.' })
  @IsOptional()
  @IsString()
  context?: string;

  @ApiPropertyOptional({ description: 'Override the worker’s configured provider.' })
  @IsOptional()
  @IsString()
  providerId?: string;

  @ApiPropertyOptional({ description: 'Associate this execution with a mission.' })
  @IsOptional()
  @IsString()
  missionId?: string;
}

@ApiTags('Workers')
@ApiBearerAuth()
@Controller('workers/:workerId/execute')
export class WorkerRuntimeController {
  constructor(private readonly runtime: WorkerRuntimeService) {}

  @Post()
  @RequirePermissions(Permissions.MissionExecute)
  @ApiParam({ name: 'workerId', example: 'clx0worker001' })
  @ApiOperation({
    summary: 'Execute a worker',
    description:
      'Runs the worker against an instruction. The runtime assembles its system ' +
      'prompt, recalled memory, retrieved knowledge and permitted tools, routes the ' +
      'call through the Provider Manager, runs the tool loop within the worker’s ' +
      'limits, writes an execution log, and stores what happened to memory.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        executionLogId: 'clx0exec0001',
        workerId: 'clx0worker001',
        status: 'SUCCEEDED',
        output: 'Completed: Summarise competitor pricing changes…',
        model: 'prism-sim-1',
        providerId: 'clx0prov0001',
        promptTokens: 412,
        completionTokens: 96,
        totalTokens: 508,
        costUsd: 0,
        latencyMs: 14,
        iterations: 1,
        toolCalls: [],
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'The worker is archived, or no provider is configured.',
  })
  execute(@Param('workerId') workerId: string, @Body() dto: ExecuteWorkerDto) {
    return this.runtime.execute({ workerId, ...dto });
  }
}

/**
 * MemoryModule is imported explicitly rather than made global: the runtime is
 * the only consumer, and an explicit edge documents that dependency where a
 * global would hide it.
 */
@Module({
  imports: [MemoryModule],
  controllers: [WorkerRuntimeController],
  providers: [WorkerRuntimeService],
  exports: [WorkerRuntimeService],
})
export class WorkerRuntimeModule {}
