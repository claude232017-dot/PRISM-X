import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { KnowledgeType } from '@prisma/client';
import {
  IsArray,
  IsEnum,
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

export class CreateKnowledgeDto {
  @ApiProperty({ example: 'Competitor pricing moved 12% in Q2' })
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  title!: string;

  @ApiProperty({ example: 'Across the top five competitors, list price rose an average of 12%…' })
  @IsString()
  @MinLength(1)
  content!: string;

  @ApiPropertyOptional({ enum: KnowledgeType, default: KnowledgeType.NOTE })
  @IsOptional()
  @IsEnum(KnowledgeType)
  type?: KnowledgeType;

  @ApiPropertyOptional({ example: ['pricing', 'competitive'], type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Worker that produced this knowledge.' })
  @IsOptional()
  @IsString()
  workerId?: string;

  @ApiPropertyOptional({ example: 'mission:clx0mission01' })
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional({ description: 'Storage object path for an attached file.' })
  @IsOptional()
  @IsString()
  storagePath?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    default: 1,
    description: 'How much the system trusts this entry.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @ApiPropertyOptional({ example: { wordCount: 420 } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateKnowledgeDto extends PartialType(CreateKnowledgeDto) {}

export class QueryKnowledgeDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: KnowledgeType })
  @IsOptional()
  @IsEnum(KnowledgeType)
  type?: KnowledgeType;

  @ApiPropertyOptional({ description: 'Full-text search across title and content.' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Comma-separated tags; matches entries carrying any of them.',
    example: 'pricing,competitive',
  })
  @IsOptional()
  @IsString()
  tags?: string;
}

export class KnowledgeResponseDto {
  @ApiProperty({ example: 'clx0know0001' }) id!: string;
  @ApiProperty({ example: 'Competitor pricing moved 12% in Q2' }) title!: string;
  @ApiProperty({ example: 'Across the top five competitors…' }) content!: string;
  @ApiProperty({ enum: KnowledgeType, example: KnowledgeType.INSIGHT }) type!: KnowledgeType;
  @ApiProperty({ example: ['pricing'], type: [String] }) tags!: string[];
  @ApiProperty({ example: 0.9 }) confidence!: number;
  @ApiProperty({ example: '2026-08-02T11:44:51.312Z' }) createdAt!: Date;
}
