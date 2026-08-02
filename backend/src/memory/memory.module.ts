import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { MemoryType } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MemoryService } from './memory.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

export class RememberDto {
  @ApiProperty({ example: 'The client prefers weekly digests over daily alerts.' })
  @IsString()
  @MinLength(2)
  content!: string;

  @ApiPropertyOptional({ enum: MemoryType, default: MemoryType.SHORT_TERM })
  @IsOptional()
  @IsEnum(MemoryType)
  type?: MemoryType;

  @ApiPropertyOptional({ example: 'preference' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ type: [String], example: ['client', 'reporting'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    default: 0.5,
    description: 'Drives retrieval ranking and survival through consolidation.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  importance?: number;

  @ApiPropertyOptional({ description: 'Lifetime in seconds for short-term entries.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(60)
  ttlSeconds?: number;
}

@ApiTags('Memory')
@ApiBearerAuth()
@Controller('workers/:workerId/memory')
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Post()
  @RequirePermissions(Permissions.WorkerUpdate)
  @ApiParam({ name: 'workerId', example: 'clx0worker001' })
  @ApiOperation({
    summary: 'Write a memory',
    description:
      'Short-term memories expire on a TTL; long-term memories persist. Emits ' +
      '`memory.updated`.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0mem00001',
        workerId: 'clx0worker001',
        type: 'LONG_TERM',
        content: 'The client prefers weekly digests over daily alerts.',
        importance: 0.8,
        tags: ['client', 'reporting'],
        createdAt: '2026-08-02T12:44:51.312Z',
      },
    },
  })
  remember(@Param('workerId') workerId: string, @Body() dto: RememberDto) {
    return this.memory.remember({ workerId, ...dto });
  }

  @Get()
  @RequirePermissions(Permissions.WorkerRead)
  @ApiParam({ name: 'workerId', example: 'clx0worker001' })
  @ApiQuery({ name: 'type', required: false, enum: MemoryType })
  @ApiOperation({ summary: 'List a worker’s live memories' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0mem00001',
          type: 'LONG_TERM',
          content: 'The client prefers weekly digests.',
          importance: 0.8,
          accessCount: 4,
          createdAt: '2026-08-02T12:44:51.312Z',
        },
      ],
    },
  })
  list(@Param('workerId') workerId: string, @Query('type') type?: MemoryType) {
    return this.memory.list(workerId, type);
  }

  @Get('recall')
  @RequirePermissions(Permissions.WorkerRead)
  @ApiParam({ name: 'workerId', example: 'clx0worker001' })
  @ApiQuery({ name: 'query', required: false, example: 'client reporting preferences' })
  @ApiQuery({ name: 'limit', required: false, example: 8 })
  @ApiOperation({
    summary: 'Recall the most relevant memories',
    description:
      'Ranks by keyword relevance, assigned importance and recency — the same ' +
      'path the worker runtime uses when assembling a prompt.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          score: 0.83,
          memory: {
            id: 'clx0mem00001',
            type: 'LONG_TERM',
            content: 'The client prefers weekly digests.',
            importance: 0.8,
          },
        },
      ],
    },
  })
  recall(
    @Param('workerId') workerId: string,
    @Query('query') query?: string,
    @Query('limit') limit?: string,
  ) {
    return this.memory.recall({
      workerId,
      query,
      limit: limit ? Math.min(Number(limit), 50) : undefined,
    });
  }

  @Get('statistics')
  @RequirePermissions(Permissions.WorkerRead)
  @ApiParam({ name: 'workerId', example: 'clx0worker001' })
  @ApiOperation({ summary: 'Memory counts by tier' })
  @ApiOkResponse({
    schema: { example: { workerId: 'clx0worker001', shortTerm: 14, longTerm: 3, total: 17 } },
  })
  statistics(@Param('workerId') workerId: string) {
    return this.memory.statistics(workerId);
  }

  @Post('consolidate')
  @RequirePermissions(Permissions.WorkerUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'workerId', example: 'clx0worker001' })
  @ApiOperation({
    summary: 'Consolidate memory',
    description:
      'Promotes short-term memories that proved important *and* repeatedly ' +
      'useful into long-term, and clears expired entries.',
  })
  @ApiOkResponse({ schema: { example: { promoted: 2, pruned: 9 } } })
  consolidate(@Param('workerId') workerId: string) {
    return this.memory.consolidate(workerId);
  }

  @Delete(':memoryId')
  @RequirePermissions(Permissions.WorkerUpdate)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'workerId', example: 'clx0worker001' })
  @ApiParam({ name: 'memoryId', example: 'clx0mem00001' })
  @ApiOperation({ summary: 'Delete a memory' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  forget(@Param('memoryId') memoryId: string) {
    return this.memory.forget(memoryId);
  }
}

@Module({
  controllers: [MemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
