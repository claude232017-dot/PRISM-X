import { ApiProperty, ApiPropertyOptional, PartialType, OmitType } from '@nestjs/swagger';
import { ProviderKind, ProviderStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../shared/dto/pagination.dto';

export class CreateProviderDto {
  @ApiProperty({ example: 'Primary reasoning provider' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    enum: ProviderKind,
    example: ProviderKind.ANTHROPIC,
    description:
      'Selects the adapter used at execution time. Vendor adapters ship in Phase 2; ' +
      'until one is registered a provider can be stored and health-checked but not invoked.',
  })
  @IsEnum(ProviderKind)
  kind!: ProviderKind;

  @ApiPropertyOptional({
    description:
      'Secret key. Encrypted with AES-256-GCM before storage and never returned by the API.',
    example: 'sk-live-…',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiPropertyOptional({
    example: { baseUrl: 'https://api.example.com', defaultModel: 'reasoning-large' },
    description: 'Non-secret configuration. Do not put credentials here — use `apiKey`.',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    default: false,
    description: 'Make this the organization’s default provider.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateProviderDto extends PartialType(
  OmitType(CreateProviderDto, ['kind'] as const),
) {}

export class QueryProvidersDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ProviderKind })
  @IsOptional()
  @IsEnum(ProviderKind)
  kind?: ProviderKind;

  @ApiPropertyOptional({ enum: ProviderStatus })
  @IsOptional()
  @IsEnum(ProviderStatus)
  status?: ProviderStatus;
}

export class ProviderResponseDto {
  @ApiProperty({ example: 'clx0prov0001' }) id!: string;
  @ApiProperty({ example: 'Primary reasoning provider' }) name!: string;
  @ApiProperty({ enum: ProviderKind, example: ProviderKind.ANTHROPIC }) kind!: ProviderKind;
  @ApiProperty({ enum: ProviderStatus, example: ProviderStatus.CONNECTED })
  status!: ProviderStatus;
  @ApiProperty({ example: true }) isDefault!: boolean;
  @ApiProperty({
    example: '****f3a9',
    description: 'Last four characters of the stored key. The key itself is never returned.',
  })
  keyHint!: string | null;
  @ApiProperty({ example: true, description: 'Whether an adapter is registered for this kind.' })
  adapterAvailable!: boolean;
  @ApiProperty({ example: '2026-08-02T11:44:51.312Z' }) createdAt!: Date;
}
