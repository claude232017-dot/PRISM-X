import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import {
  ExternalIdentity,
  IAuthProvider,
  IssuedTokens,
  VerifiedToken,
} from './auth-provider.interface';

/**
 * Supabase Auth driver.
 *
 * Supabase owns credentials, sessions, email verification and recovery mail.
 * It does **not** own authorization: roles, permissions and org membership are
 * resolved from our own tables after the token is verified. That split is what
 * keeps Supabase a data platform rather than the application's brain — swapping
 * it out later touches this file and nothing else.
 */
@Injectable()
export class SupabaseAuthProvider implements IAuthProvider {
  readonly name = 'supabase' as const;
  private readonly logger = new Logger(SupabaseAuthProvider.name);
  private readonly admin: SupabaseClient;
  private readonly anon: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    const url = this.config.getOrThrow<string>('supabase.url');
    this.admin = createClient(
      url,
      this.config.getOrThrow<string>('supabase.serviceRoleKey'),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    this.anon = createClient(url, this.config.getOrThrow<string>('supabase.anonKey'), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async register(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<ExternalIdentity> {
    const { data, error } = await this.admin.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: false,
      user_metadata: { display_name: input.displayName },
    });

    if (error) {
      if (/already registered|already exists/i.test(error.message)) {
        throw new ConflictException('An account with that email already exists');
      }
      this.logger.error(`Supabase register failed: ${error.message}`);
      throw new UnauthorizedException(error.message);
    }

    return {
      externalId: data.user!.id,
      email: data.user!.email!,
      emailVerified: Boolean(data.user!.email_confirmed_at),
      displayName: input.displayName ?? null,
    };
  }

  async login(input: { email: string; password: string }) {
    const { data, error } = await this.anon.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    });

    if (error || !data.session) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return {
      identity: {
        externalId: data.user!.id,
        email: data.user!.email!,
        emailVerified: Boolean(data.user!.email_confirmed_at),
        displayName: (data.user!.user_metadata?.display_name as string) ?? null,
      },
      tokens: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in ?? 3600,
        tokenType: 'Bearer' as const,
      },
    };
  }

  async logout(accessToken: string): Promise<void> {
    const { error } = await this.admin.auth.admin.signOut(accessToken);
    if (error) this.logger.warn(`Supabase signOut: ${error.message}`);
  }

  async verify(accessToken: string): Promise<VerifiedToken> {
    const { data, error } = await this.admin.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return {
      externalId: data.user.id,
      email: data.user.email!,
      claims: (data.user.user_metadata ?? {}) as Record<string, unknown>,
    };
  }

  async refresh(refreshToken: string): Promise<IssuedTokens> {
    const { data, error } = await this.anon.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in ?? 3600,
      tokenType: 'Bearer',
    };
  }

  async requestPasswordReset(email: string): Promise<void> {
    // Supabase already declines to reveal whether the address exists.
    const { error } = await this.anon.auth.resetPasswordForEmail(email);
    if (error) this.logger.warn(`Password reset request: ${error.message}`);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const { data, error } = await this.anon.auth.verifyOtp({
      token_hash: token,
      type: 'recovery',
    });
    if (error || !data.user) {
      throw new UnauthorizedException('Reset token is invalid or has expired');
    }
    const { error: updateError } = await this.admin.auth.admin.updateUserById(
      data.user.id,
      { password: newPassword },
    );
    if (updateError) throw new UnauthorizedException(updateError.message);
  }

  async sendVerificationEmail(email: string): Promise<void> {
    const { error } = await this.anon.auth.resend({ type: 'signup', email });
    if (error) this.logger.warn(`Verification resend: ${error.message}`);
  }
}
