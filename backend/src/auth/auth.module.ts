import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AUTH_PROVIDER, IAuthProvider } from './providers/auth-provider.interface';
import { LocalAuthProvider } from './providers/local-auth.provider';
import { SupabaseAuthProvider } from './providers/supabase-auth.provider';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import {
  MembershipRepository,
  UserRepository,
} from '../database/repositories/identity.repositories';
import { CacheService } from '../shared/cache/cache.service';

/**
 * The active auth driver is chosen once, at boot, from AUTH_PROVIDER.
 * Everything downstream depends on the IAuthProvider token, so neither
 * implementation leaks into the rest of the application.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('auth.jwtSecret'),
        signOptions: { expiresIn: config.get<string>('auth.jwtExpiresIn', '1h') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    LocalAuthProvider,
    JwtAuthGuard,
    PermissionsGuard,
    {
      provide: AUTH_PROVIDER,
      inject: [ConfigService, LocalAuthProvider],
      useFactory: (config: ConfigService, local: LocalAuthProvider): IAuthProvider =>
        config.get<string>('auth.driver') === 'supabase'
          ? new SupabaseAuthProvider(config)
          : local,
    },
  ],
  exports: [AuthService, JwtAuthGuard, PermissionsGuard, AUTH_PROVIDER],
})
export class AuthModule {}

// Re-exported so feature modules can inject these without deep imports.
export { UserRepository, MembershipRepository, CacheService };
