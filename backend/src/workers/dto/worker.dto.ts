import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { WorkerStatus } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationQueryDto } from '../../shared/dto/pagination.dto';

export class CreateWorkerDto {
  @ApiProperty({ example: 'Market Scout', description: 'Human-readable worker name.' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'researcher', description: 'Functional role within a mission.' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  role!: string;

  @ApiPropertyOptional({
    enum: WorkerStatus,
    default: WorkerStatus.DORMANT,
    description: 'Workers start dormant and are activated explicitly.',
  })
  @IsOptional()
  @IsEnum(WorkerStatus)
  status?: WorkerStatus;

  @ApiPropertyOptional({
    example: { tone: 'analytical', riskAppetite: 0.3 },
    description: 'Behavioural configuration carried across generations.',
  })
  @IsOptional()
  @IsObject()
  dna?: Record<string, unknown>;

  @ApiPropertyOptional({ example: ['web-search', 'summarize'], type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capabilities?: string[];

  @ApiPropertyOptional({ description: 'Intelligence provider this worker runs on.' })
  @IsOptional()
  @IsString()
  providerId?: string;

  // --- Phase 2: executable identity --------------------------------

  @ApiPropertyOptional({
    example: 'You are a precise pricing analyst. Cite your sources.',
    description: 'Standing instructions prepended to every execution.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  systemPrompt?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['pricing', 'competitive analysis'],
    description: 'Competencies used when matching workers to tasks during planning.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @ApiPropertyOptional({
    example: 'claude-sonnet-4-5',
    description: 'Overrides the provider’s default model.',
  })
  @IsOptional()
  @IsString()
  defaultModel?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 2, default: 0.7 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({
    type: [String],
    example: ['knowledge.search', 'analytics.summary'],
    description:
      'Tool keys this worker may invoke. Empty means no tool access — capability ' +
      'is granted explicitly, never by default.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  toolPermissions?: string[];

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 20,
    default: 5,
    description: 'Maximum tool-loop iterations before the run is cut off.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  maxIterations?: number;

  @ApiPropertyOptional({ minimum: 256, maximum: 128000, default: 4096 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(256)
  @Max(128_000)
  maxTokens?: number;

  @ApiPropertyOptional({ minimum: 1000, default: 120000, description: 'Wall-clock limit (ms).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  timeoutMs?: number;

  @ApiPropertyOptional({
    description: 'Hard spend ceiling per execution, in USD. Null means unlimited.',
    example: 0.5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costLimitUsd?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether the Provider Manager may fall back to another healthy provider when ' +
      'this worker’s provider fails. Set false to pin a worker to one provider.',
  })
  @IsOptional()
  @IsBoolean()
  allowFailover?: boolean;

  @ApiPropertyOptional({
    example: 'clx0node0001',
    description:
      'Pin this worker to one node. Left unset — the normal case — the scheduler places ' +
      'each execution on whichever node currently fits best.',
  })
  @IsOptional()
  @IsString()
  preferredNodeId?: string;

  @ApiPropertyOptional({
    example: { requiresGpu: true, minMemoryMb: 8192, labels: ['inference'] },
    description:
      'Constraints a node must satisfy to run this worker. Unsatisfiable constraints ' +
      'mean the worker waits rather than running somewhere unsuitable.',
  })
  @IsOptional()
  @IsObject()
  nodeRequirements?: Record<string, unknown>;
}

export class UpdateWorkerDto extends PartialType(CreateWorkerDto) {
  @ApiPropertyOptional({ minimum: 1, description: 'Evolution generation.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  generation?: number;
}

export class QueryWorkersDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WorkerStatus })
  @IsOptional()
  @IsEnum(WorkerStatus)
  status?: WorkerStatus;

  @ApiPropertyOptional({ description: 'Filter by functional role.' })
  @IsOptional()
  @IsString()
  role?: string;
}

export class WorkerResponseDto {
  @ApiProperty({ example: 'clx0worker001' }) id!: string;
  @ApiProperty({ example: 'clx0org0001' }) organizationId!: string;
  @ApiProperty({ example: 'Market Scout' }) name!: string;
  @ApiProperty({ example: 'researcher' }) role!: string;
  @ApiProperty({ enum: WorkerStatus, example: WorkerStatus.ACTIVE }) status!: WorkerStatus;
  @ApiProperty({ example: { tone: 'analytical' } }) dna!: Record<string, unknown>;
  @ApiProperty({ example: ['web-search'], type: [String] }) capabilities!: string[];
  @ApiProperty({ example: 1 }) generation!: number;
  @ApiProperty({ example: 0.82 }) fitness!: number;
  @ApiProperty({ example: '2026-08-02T11:44:51.312Z' }) createdAt!: Date;
}
