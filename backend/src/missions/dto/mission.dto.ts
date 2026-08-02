import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { MissionStatus, Priority, TaskStatus } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationQueryDto } from '../../shared/dto/pagination.dto';

export class CreateTaskDto {
  @ApiProperty({ example: 'Collect competitor pricing' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ example: 'Pull public pricing pages for the top 5 competitors.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: Priority, default: Priority.MEDIUM })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @ApiPropertyOptional({ description: 'Worker assigned to run this task.' })
  @IsOptional()
  @IsString()
  workerId?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Ids of sibling tasks that must complete first. Forms the mission DAG; ' +
      'validated to be acyclic and to reference tasks in the same mission.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dependsOn?: string[];
}

export class CreateMissionDto {
  @ApiProperty({ example: 'Q3 competitive sweep' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ example: 'Map competitor pricing and positioning changes since Q2.' })
  @IsString()
  @MinLength(2)
  objective!: string;

  @ApiPropertyOptional({ enum: Priority, default: Priority.MEDIUM })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @ApiPropertyOptional({ example: { source: 'template:market-research' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: [CreateTaskDto],
    description: 'Tasks created with the mission. Dependencies use array indices.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTaskDto)
  tasks?: CreateTaskDto[];
}

export class UpdateMissionDto extends PartialType(CreateMissionDto) {}

export class UpdateTaskDto {
  @ApiPropertyOptional({ enum: TaskStatus })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({ description: 'Worker assigned to run this task.' })
  @IsOptional()
  @IsString()
  workerId?: string;

  @ApiPropertyOptional({ example: { findings: 3 } })
  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'Upstream API returned 503' })
  @IsOptional()
  @IsString()
  error?: string;
}

export class QueryMissionsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MissionStatus })
  @IsOptional()
  @IsEnum(MissionStatus)
  status?: MissionStatus;

  @ApiPropertyOptional({ enum: Priority })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;
}

export class MissionResponseDto {
  @ApiProperty({ example: 'clx0mission01' }) id!: string;
  @ApiProperty({ example: 'Q3 competitive sweep' }) title!: string;
  @ApiProperty({ example: 'Map competitor pricing changes.' }) objective!: string;
  @ApiProperty({ enum: MissionStatus, example: MissionStatus.RUNNING }) status!: MissionStatus;
  @ApiProperty({ enum: Priority, example: Priority.HIGH }) priority!: Priority;
  @ApiProperty({ example: 40, description: 'Percent of tasks completed.' }) progress!: number;
  @ApiProperty({ example: '2026-08-02T11:44:51.312Z' }) createdAt!: Date;
}
