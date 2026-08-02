import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PASSWORD_RULE =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$/;
const PASSWORD_MESSAGE =
  'Password must be at least 12 characters and include an uppercase letter, a lowercase letter and a digit';

export class RegisterDto {
  @ApiProperty({ example: 'operator@prism-x.io', description: 'Account email address.' })
  @IsEmail({}, { message: 'A valid email address is required' })
  email!: string;

  @ApiProperty({
    example: 'CorrectHorse42Battery',
    description: 'Minimum 12 characters, with upper, lower and a digit.',
  })
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password!: string;

  @ApiPropertyOptional({ example: 'Ada Lovelace' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({
    example: 'Prism Labs',
    description: 'Name for the organization created alongside the account.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  organizationName?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'operator@prism-x.io' })
  @IsEmail({}, { message: 'A valid email address is required' })
  email!: string;

  @ApiProperty({ example: 'CorrectHorse42Battery' })
  @IsString()
  password!: string;

  @ApiPropertyOptional({
    description:
      'Organization to sign in to. Omit to use the first active membership.',
  })
  @IsOptional()
  @IsString()
  organizationId?: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token issued at login.' })
  @IsString()
  refreshToken!: string;
}

export class RequestPasswordResetDto {
  @ApiProperty({ example: 'operator@prism-x.io' })
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Recovery token from the reset email.' })
  @IsString()
  token!: string;

  @ApiProperty({ example: 'NewCorrectHorse42' })
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password!: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'operator@prism-x.io' })
  @IsEmail()
  email!: string;
}

export class AuthTokensResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken!: string;

  @ApiPropertyOptional({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  refreshToken?: string;

  @ApiProperty({ example: 3600, description: 'Access token lifetime in seconds.' })
  expiresIn!: number;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;
}
