import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService, AuthenticatedPrincipal } from './auth.service';
import {
  AuthTokensResponseDto,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
  RequestPasswordResetDto,
  ResendVerificationDto,
  ResetPasswordDto,
} from './dto/auth.dto';
import { CurrentUser, Public } from './decorators/permissions.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Public()
  @ApiOperation({
    summary: 'Register an account and provision its organization',
    description:
      'Creates the identity with the configured auth provider, then creates a local ' +
      'user, a new organization, and an OWNER membership binding them — all in one ' +
      'transaction. Returns tokens for the new session.',
  })
  @ApiCreatedResponse({
    description: 'Account created and signed in.',
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiJ9...',
        refreshToken: 'eyJhbGciOiJIUzI1NiJ9...',
        expiresIn: 3600,
        tokenType: 'Bearer',
        user: { id: 'clx0user0001', email: 'operator@prism-x.io', displayName: 'Ada Lovelace' },
        organization: { id: 'clx0org0001', name: 'Prism Labs', slug: 'prism-labs' },
      },
    },
  })
  @ApiConflictResponse({ description: 'An account with that email already exists.' })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Verifies credentials and returns tokens plus the resolved organization, role ' +
      'and permission set. Pass `organizationId` to select a specific workspace when ' +
      'the account belongs to more than one.',
  })
  @ApiOkResponse({
    description: 'Signed in.',
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiJ9...',
        refreshToken: 'eyJhbGciOiJIUzI1NiJ9...',
        expiresIn: 3600,
        tokenType: 'Bearer',
        user: { id: 'clx0user0001', email: 'operator@prism-x.io', displayName: 'Ada Lovelace' },
        organization: { id: 'clx0org0001', name: 'Prism Labs' },
        role: 'OWNER',
        permissions: ['worker:read', 'worker:create', 'mission:execute'],
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sign out',
    description:
      'Revokes the session with the auth provider where supported and clears the ' +
      'cached authorization record for this user.',
  })
  @ApiOkResponse({ schema: { example: { success: true } } })
  logout(@Req() req: { accessToken: string }, @CurrentUser('userId') userId: string) {
    return this.auth.logout(req.accessToken, userId);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new access token' })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'Refresh token is invalid or expired.' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('password-reset/request')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password reset email',
    description:
      'Always returns success, whether or not the address is registered, so the ' +
      'endpoint cannot be used to enumerate accounts.',
  })
  @ApiOkResponse({ schema: { example: { success: true } } })
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.auth.requestPasswordReset(dto.email);
  }

  @Post('password-reset/confirm')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a password reset using the emailed token' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiUnauthorizedResponse({ description: 'Reset token is invalid or expired.' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  @Post('verify-email/resend')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-send the email verification message' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.auth.sendVerificationEmail(dto.email);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Describe the current session',
    description:
      'Returns the authenticated user, the organization this request acts within, ' +
      'and the effective permission set for their role.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        userId: 'clx0user0001',
        email: 'operator@prism-x.io',
        organizationId: 'clx0org0001',
        organizationName: 'Prism Labs',
        roleKey: 'OWNER',
        permissions: ['worker:read', 'worker:create'],
      },
    },
  })
  me(@CurrentUser() user: AuthenticatedPrincipal) {
    return user;
  }
}
