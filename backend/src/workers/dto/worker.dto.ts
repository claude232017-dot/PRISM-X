import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { WorkerStatus } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
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
