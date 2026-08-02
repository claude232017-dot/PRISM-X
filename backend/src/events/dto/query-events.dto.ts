import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../shared/dto/pagination.dto';

/**
 * A real class, not `PaginationQueryDto & { name?: string }`.
 *
 * TypeScript intersection types erase at runtime, so Nest sees `Object` as the
 * parameter's metatype and skips validation and transformation entirely —
 * `limit` arrives as the string "100" and reaches Prisma as a string, and the
 * `skip` getter inherited from PaginationQueryDto never exists at all.
 */
export class QueryEventsDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Filter to a single event name.',
    example: 'mission.completed',
  })
  @IsOptional()
  @IsString()
  name?: string;
}
